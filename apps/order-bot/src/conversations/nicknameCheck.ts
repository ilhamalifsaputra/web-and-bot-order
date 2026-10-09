/** Collect canonical fields first; nickname checking is advisory. */
import { NicknameService } from "@app/core/nickname/service";
import { logger } from "@app/core/logger";
import { validateCustomerData, type AdditionalField } from "@app/core/deliveryFields";
import { buildPlayerNicknameRequest, parseInputFields } from "@app/core/playerInput";
import { prisma, getDenominationWithProduct, resolveNicknameGate, buildNicknameProviderEntries } from "@app/db";
import type { MyContext, MyConversation } from "../context";
import { menuAnchor, consumeInput } from "../util/chat";
import { esc } from "../util/format";
import { coreT } from "../util/i18n";
import * as ckb from "../keyboards/customer";
import { renderOrderConfirmation } from "../handlers/checkout";
import { startCommand, handleProductNumber } from "../handlers/customer";
import { customerInfoConversation } from "./customerInfo";

export async function nicknameCheckConversation(conversation: MyConversation, ctx: MyContext): Promise<void> {
  ctx.session.scratch.pendingInfoProductId = ctx.session.scratch.pendingNicknameProductId;
  ctx.session.scratch.pendingInfoQuantity = ctx.session.scratch.pendingNicknameQuantity;
  await customerInfoConversation(conversation, ctx);
}

export function clearPlayerInputScratch(ctx: MyContext): void {
  for (const key of ["customerData", "customerInputOwner", "pendingInfoProductId", "pendingInfoQuantity", "pendingNicknameProductId", "pendingNicknameQuantity", "prefilledCustomerDataUnit", "checkoutIntentId"]) delete ctx.session.scratch[key];
}

export async function confirmCustomerInputs(conversation: MyConversation, ctx: MyContext, productId: number, quantity: number, fields: AdditionalField[], answers: Array<Record<string, string>>): Promise<void> {
  const lang = ctx.session.lang;
  const checked = await conversation.external(async () => {
    const denom = await getDenominationWithProduct(prisma, productId);
    if (!denom || !denom.isActive || !denom.product.isActive || denom.product.isArchived) return null;
    const currentFields = parseInputFields(denom.additionalFields);
    if (JSON.stringify(currentFields) !== JSON.stringify(fields)) return null;
    const normalized = validateCustomerData(currentFields, answers, quantity);
    // The lookup is advisory: any failure here (provider, credentials, a bad
    // mapping) proceeds to confirmation instead of stranding the buyer.
    let result: Awaited<ReturnType<NicknameService["checkNickname"]>> | null = null;
    try {
      const gate = resolveNicknameGate(denom);
      const entries = await buildNicknameProviderEntries(prisma, gate.gameCode);
      if (entries.length > 0) result = await new NicknameService(entries).checkNickname(buildPlayerNicknameRequest(currentFields, denom.providerInputMapping, normalized[0]));
    } catch (err) {
      logger.warn({ err, denominationId: productId }, "The bot's nickname lookup failed unexpectedly, so the buyer continues to order confirmation without a verified nickname.");
    }
    return { normalized, result, owner: JSON.stringify([productId, quantity, denom.additionalFields, denom.providerInputMapping, denom.nicknameCheckGameCode]) };
  });
  if (!checked) { clearPlayerInputScratch(ctx); await startCommand(ctx); return; }
  const finalize = async (u: MyContext) => {
    clearPlayerInputScratch(u);
    u.session.scratch.customerData = JSON.stringify(checked.normalized);
    u.session.scratch.customerInputOwner = checked.owner;
    await renderOrderConfirmation(u, productId, quantity);
  };
  if (!checked.result || (checked.result.status !== "found" && !(checked.result.status === "not_found" && checked.result.definitive))) { await finalize(ctx); return; }
  const found = checked.result.status === "found";
  const resultText = found ? coreT("checkout.nickname_found", lang, { nickname: esc(checked.result.status === "found" ? checked.result.nickname : "") }) : coreT("checkout.nickname_not_found", lang);
  const resultKb = found ? ckb.nicknameConfirmKb(productId, quantity, lang) : ckb.nicknameNotFoundKb(productId, quantity, lang);
  await menuAnchor(ctx, resultText, resultKb);
  for (;;) {
    const u = await conversation.wait();
    const data = u.callbackQuery?.data ?? "";
    const text = u.message?.text ?? "";
    if ((data === ckb.cb("nick", "confirm") && found) || (data === ckb.cb("nick", "continue") && !found)) { await u.answerCallbackQuery(); await finalize(u); return; }
    if (data === ckb.cb("nick", "retry")) {
      // customerInfoConversation answers this tap itself; answering it here
      // too made Telegram reject the second answer and the retry threw.
      clearPlayerInputScratch(u);
      u.session.scratch.pendingInfoProductId = productId;
      u.session.scratch.pendingInfoQuantity = quantity;
      await customerInfoConversation(conversation, u); return;
    }
    if (/^\/(start|cancel)(?:@\w+)?(?:\s|$)/.test(text) || data.startsWith("v1:buy:")) { if (u.callbackQuery) await u.answerCallbackQuery(); clearPlayerInputScratch(u); await startCommand(u); return; }
    if (ckb.isPersistentLabel(text)) { clearPlayerInputScratch(u); await handleProductNumber(u); return; }
    if (u.message) {
      // A typed message here (usually a corrected ID) is not silently
      // dropped: delete it and re-render this same bubble saying how to
      // enter a new ID. It is not taken as the new ID itself, because the
      // wizard may need several fields (ID + Zone) re-asked in order, which
      // Try Again already does.
      await consumeInput(u);
      await menuAnchor(u, `${coreT("checkout.nickname_retry_hint", lang)}\n\n${resultText}`, resultKb);
      continue;
    }
    if (u.callbackQuery) await u.answerCallbackQuery({ text: coreT("error.stale_screen", lang) });
  }
}
