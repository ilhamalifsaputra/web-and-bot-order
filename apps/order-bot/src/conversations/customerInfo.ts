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
  parseAdditionalFields,
  validateFieldAnswer,
  type AdditionalField,
} from "@app/core/deliveryFields";
import { prisma, getDenomination } from "@app/db";
import type { MyContext, MyConversation } from "../context";
import { menuAnchor, consumeInput } from "../util/chat";
import { esc } from "../util/format";
import { coreT } from "../util/i18n";
import * as ckb from "../keyboards/customer";
import { showOrderConfirmation, renderOrderConfirmation } from "../handlers/checkout";
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
  const fields = parseAdditionalFields(product?.additionalFields ?? null);
  if (fields.length === 0) {
    // Defensive — shouldn't normally happen for a manual_with_info SKU with no
    // fields configured. Nothing to collect; go straight to confirmation.
    await renderOrderConfirmation(ctx, productId, quantity);
    return;
  }

  if (ctx.callbackQuery) await ctx.answerCallbackQuery();
  const cancelKb = ckb.voucherCancelKb(productId, quantity, lang);
  await menuAnchor(ctx, fieldPrompt(lang, 0, quantity, fields[0]!), cancelKb);

  const answers: Array<Record<string, string>> = [];
  let currentUnit: Record<string, string> = {};
  let unitIdx = 0;
  let fieldIdx = 0;

  for (;;) {
    const u = await conversation.wait();
    const data = u.callbackQuery?.data ?? "";
    if (data.startsWith("v1:buy:")) {
      // voucherCancelKb routes to v1:buy — abandon info-collection and
      // re-enter showOrderConfirmation's gate cleanly (customerData is still
      // unset, so a fresh "Buy" tap will land back in this same wizard).
      await u.answerCallbackQuery();
      await showOrderConfirmation(u, productId, quantity);
      return;
    }
    if (isCmd(u, "start")) {
      await startCommand(u);
      return;
    }
    if (isCmd(u, "cancel")) {
      await showOrderConfirmation(u, productId, quantity);
      return;
    }
    const text = u.message?.text;
    if (!text) continue;
    if (ckb.isPersistentLabel(text)) {
      await handleProductNumber(u);
      return;
    }

    // Anchor pattern: the typed answer is deleted and every retry edits the
    // field-prompt bubble instead of stacking error replies.
    await consumeInput(u);

    const field = fields[fieldIdx]!;
    let value: string;
    try {
      value = validateFieldAnswer(field, text);
    } catch (e) {
      if (e instanceof ValidationError) {
        await menuAnchor(u, fieldPrompt(lang, unitIdx, quantity, field, e.key, e.formatArgs), cancelKb);
        continue;
      }
      throw e;
    }

    currentUnit[field.key] = value;
    fieldIdx++;
    if (fieldIdx < fields.length) {
      await menuAnchor(u, fieldPrompt(lang, unitIdx, quantity, fields[fieldIdx]!), cancelKb);
      continue;
    }

    // This unit's answers are complete.
    answers.push(currentUnit);
    currentUnit = {};
    fieldIdx = 0;
    unitIdx++;
    if (unitIdx < quantity) {
      await menuAnchor(u, fieldPrompt(lang, unitIdx, quantity, fields[0]!), cancelKb);
      continue;
    }

    // All quantity × fields.length answers collected — hand off to checkout.
    u.session.scratch.customerData = JSON.stringify(answers);
    delete u.session.scratch.pendingInfoProductId;
    delete u.session.scratch.pendingInfoQuantity;
    await renderOrderConfirmation(u, productId, quantity);
    return;
  }
}
