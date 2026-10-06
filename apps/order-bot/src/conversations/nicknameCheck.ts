/** Collect canonical fields first; nickname checking is advisory. */
import { NicknameService } from "@app/core/nickname/service";
import { validateCustomerData, type AdditionalField } from "@app/core/deliveryFields";
import { buildPlayerNicknameRequest, parseInputFields } from "@app/core/playerInput";
import { prisma, getDenominationWithProduct, resolveNicknameGate, buildNicknameProviderEntries } from "@app/db";
import type { MyContext, MyConversation } from "../context";
import { menuAnchor } from "../util/chat";
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
    const gate = resolveNicknameGate(denom);
    const entries = await buildNicknameProviderEntries(prisma, gate.gameCode);
    const result = entries.length > 0 ? await new NicknameService(entries).checkNickname(buildPlayerNicknameRequest(currentFields, denom.providerInputMapping, normalized[0])) : null;
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
  await menuAnchor(ctx, found ? coreT("checkout.nickname_found", lang, { nickname: esc(checked.result.status === "found" ? checked.result.nickname : "") }) : coreT("checkout.nickname_not_found", lang), found ? ckb.nicknameConfirmKb(productId, quantity, lang) : ckb.nicknameNotFoundKb(productId, quantity, lang));
  for (;;) {
    const u = await conversation.wait();
    const data = u.callbackQuery?.data ?? "";
    const text = u.message?.text ?? "";
    if ((data === ckb.cb("nick", "confirm") && found) || (data === ckb.cb("nick", "continue") && !found)) { await u.answerCallbackQuery(); await finalize(u); return; }
    if (data === ckb.cb("nick", "retry")) {
      await u.answerCallbackQuery(); clearPlayerInputScratch(u);
      u.session.scratch.pendingInfoProductId = productId;
      u.session.scratch.pendingInfoQuantity = quantity;
      await customerInfoConversation(conversation, u); return;
    }
    if (/^\/(start|cancel)(?:@\w+)?(?:\s|$)/.test(text) || data.startsWith("v1:buy:")) { if (u.callbackQuery) await u.answerCallbackQuery(); clearPlayerInputScratch(u); await startCommand(u); return; }
    if (ckb.isPersistentLabel(text)) { clearPlayerInputScratch(u); await handleProductNumber(u); return; }
    if (u.callbackQuery) await u.answerCallbackQuery({ text: coreT("error.stale_screen", lang) });
  }
}
