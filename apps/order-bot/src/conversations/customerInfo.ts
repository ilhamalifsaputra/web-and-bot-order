/**
 * Customer info-collection conversation — for a manual_with_info SKU, the
 * buyer must fill the admin-defined custom fields (e.g. game ID, email)
 * BEFORE payment. Entered programmatically from checkout.ts's
 * showOrderConfirmation (not from a callback/command trigger — see
 * conversations/index.ts) once per checkout attempt; scratch.customerData
 * being unset is what makes the gate re-enter this same conversation on a
 * retry (see showOrderConfirmation's doc comment).
 *
 * Single-bubble wizard, same shape as voucherConversation (checkout.ts):
 * menuAnchor prompt, consumeInput on the typed reply, re-prompt the SAME
 * bubble on a validation error, and the standard /start, /cancel,
 * persistent-label escapes.
 *
 * Replay-safety: DB reads that precede a further wait() are wrapped in
 * conversation.external(); the terminal write (scratch.customerData +
 * renderOrderConfirmation) runs once, after the last wait(), with no more
 * waits after it.
 */
import { ValidationError } from "@app/core/errors";
import {
  AdditionalFieldType,
  validateFieldAnswer,
  type AdditionalField,
} from "@app/core/deliveryFields";
import { prisma, getDenomination } from "@app/db";
import { parseInputFields } from "@app/core/playerInput";
import { InlineKeyboard } from "grammy";
import { clearPlayerInputScratch, confirmCustomerInputs } from "./nicknameCheck";
import type { MyContext, MyConversation } from "../context";
import { menuAnchor, consumeInput } from "../util/chat";
import { esc } from "../util/format";
import { coreT } from "../util/i18n";
import * as ckb from "../keyboards/customer";
import { renderOrderConfirmation } from "../handlers/checkout";
import { startCommand, handleProductNumber } from "../handlers/customer";

function isCmd(ctx: MyContext, cmd: string): boolean {
  const text = ctx.message?.text ?? "";
  return text === `/${cmd}` || text.startsWith(`/${cmd} `) || text.startsWith(`/${cmd}@`);
}

/** Render one field's prompt, with a running "Unit N of M" header and an
 * optional validation-error line prepended (mirrors voucherConversation's
 * promptAgain helper). `unit`/`fieldsLength` are 0-based/used for display only. */
function fieldPrompt(
  lang: string,
  unit: number,
  quantity: number,
  field: AdditionalField,
  errorKey?: string,
  errorArgs?: Record<string, unknown>,
): string {
  const label = esc((field.label as Record<string, string>)[lang] ?? field.label.en);
  let body = coreT("checkout.info_field_prompt", lang, { unit: unit + 1, total: quantity, label });
  if (field.type === AdditionalFieldType.SELECT) {
    body += "\n" + coreT("checkout.info_select_options", lang, { options: esc(field.options.join(", ")) });
  }
  if (field.placeholder) {
    body += "\n" + coreT("checkout.info_placeholder", lang, { placeholder: esc(field.placeholder) });
  }
  return errorKey ? `${coreT(errorKey, lang, errorArgs)}\n\n${body}` : body;
}

export async function customerInfoConversation(conversation: MyConversation, ctx: MyContext): Promise<void> {
  const lang = ctx.session.lang;
  const productId = ctx.session.scratch.pendingInfoProductId as number;
  const quantity = ctx.session.scratch.pendingInfoQuantity as number;

  const product = await conversation.external(() => getDenomination(prisma, productId));
  const fields = parseInputFields(product?.additionalFields ?? null);
  if (fields.length === 0) {
    // Defensive — shouldn't normally happen for a manual_with_info SKU with no
    // fields configured. Nothing to collect; go straight to confirmation.
    await renderOrderConfirmation(ctx, productId, quantity);
    return;
  }

  // A nickname-check handoff (nicknameCheck.ts, MANUAL_WITH_INFO + quantity >
  // 1) already collected unit 1's answer before entering this conversation —
  // pick it up here so the wizard resumes at unit 2 instead of re-asking for
  // unit 1's fields (final-review round 2 fix; see nicknameCheck.ts's
  // finalizeNicknameCheck for the write side of this handoff).
  const prefilledJson = ctx.session.scratch.prefilledCustomerDataUnit as string | undefined;
  if (prefilledJson) delete ctx.session.scratch.prefilledCustomerDataUnit;
  const answers: Array<Record<string, string>> = prefilledJson ? [JSON.parse(prefilledJson)] : [];
  let unitIdx = prefilledJson ? 1 : 0;

  if (ctx.callbackQuery) await ctx.answerCallbackQuery();
  const cancelKb = ckb.voucherCancelKb(productId, quantity, lang);
  const fieldKb = (index: number) => {
    const field = fields[index]!;
    const kb = new InlineKeyboard();
    if (field.type === AdditionalFieldType.SELECT) field.options.forEach((option, i) => kb.text(option, ckb.cb("input", "option", index, i)).row());
    if (!field.required) kb.text(coreT("checkout.input_skip", lang), ckb.cb("input", "skip", index)).row();
    if (index > 0) kb.text(coreT("menu.back", lang), ckb.cb("input", "back")).row();
    for (const row of cancelKb.inline_keyboard) kb.inline_keyboard.push(row);
    return kb;
  };

  if (unitIdx >= quantity) {
    // Defensive — shouldn't happen given nicknameCheck.ts's own quantity > 1
    // guard, but never strand the buyer if it ever does: the prefilled unit
    // alone already satisfies the full quantity.
    await confirmCustomerInputs(conversation, ctx, productId, quantity, fields, answers);
    return;
  }

  await menuAnchor(ctx, fieldPrompt(lang, unitIdx, quantity, fields[0]!), fieldKb(0));

  let currentUnit: Record<string, string> = {};
  let fieldIdx = 0;

  for (;;) {
    const u = await conversation.wait();
    const data = u.callbackQuery?.data ?? "";
    if (data.startsWith("v1:buy:")) {
      // voucherCancelKb routes to v1:buy — abandon info-collection and
      // re-enter showOrderConfirmation's gate cleanly (customerData is still
      // unset, so a fresh "Buy" tap will land back in this same wizard).
      await u.answerCallbackQuery();
      clearPlayerInputScratch(u);
      await startCommand(u);
      return;
    }
    if (isCmd(u, "start")) {
      clearPlayerInputScratch(u);
      await startCommand(u);
      return;
    }
    if (isCmd(u, "cancel")) {
      clearPlayerInputScratch(u);
      await startCommand(u);
      return;
    }
    if (data === ckb.cb("input", "back") && fieldIdx > 0) {
      await u.answerCallbackQuery(); fieldIdx--;
      for (const field of fields.slice(fieldIdx)) delete currentUnit[field.key];
      await menuAnchor(u, fieldPrompt(lang, unitIdx, quantity, fields[fieldIdx]!), fieldKb(fieldIdx)); continue;
    }
    const option = fields[fieldIdx]?.type === AdditionalFieldType.SELECT && data.startsWith(ckb.cb("input", "option", fieldIdx) + ":") ? fields[fieldIdx]!.options[Number(data.split(":").at(-1))] : undefined;
    const skip = !fields[fieldIdx]!.required && data === ckb.cb("input", "skip", fieldIdx);
    const text = option ?? (skip ? " " : u.message?.text);
    if (!text) {
      // An inline tap that doesn't match v1:buy: (e.g. a stale/duplicate
      // tap) — clear its spinner instead of leaving it hanging (M-22 fix).
      if (u.callbackQuery) await u.answerCallbackQuery({ text: coreT("error.stale_screen", lang) });
      continue;
    }
    if (ckb.isPersistentLabel(text)) {
      clearPlayerInputScratch(u);
      await handleProductNumber(u);
      return;
    }

    // Anchor pattern: the typed answer is deleted and every retry edits the
    // field-prompt bubble instead of stacking error replies.
    if (u.callbackQuery) await u.answerCallbackQuery();
    else await consumeInput(u);

    const field = fields[fieldIdx]!;
    let value: string;
    try {
      value = validateFieldAnswer(field, text);
    } catch (e) {
      if (e instanceof ValidationError) {
        await menuAnchor(u, fieldPrompt(lang, unitIdx, quantity, field, e.key, e.formatArgs), fieldKb(fieldIdx));
        continue;
      }
      throw e;
    }

    currentUnit[field.key] = value;
    fieldIdx++;
    if (fieldIdx < fields.length) {
      await menuAnchor(u, fieldPrompt(lang, unitIdx, quantity, fields[fieldIdx]!), fieldKb(fieldIdx));
      continue;
    }

    // This unit's answers are complete.
    answers.push(currentUnit);
    currentUnit = {};
    fieldIdx = 0;
    unitIdx++;
    if (unitIdx < quantity) {
      await menuAnchor(u, fieldPrompt(lang, unitIdx, quantity, fields[0]!), fieldKb(0));
      continue;
    }

    // All quantity × fields.length answers collected — hand off to checkout.
    await confirmCustomerInputs(conversation, u, productId, quantity, fields, answers);
    return;
  }
}
