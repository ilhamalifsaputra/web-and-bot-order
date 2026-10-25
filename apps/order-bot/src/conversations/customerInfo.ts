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
 * Game Top-up (the category's group resolves to GAME_TOPUP) asks for every
 * account field of a unit in ONE message ("123456789 1234"), parsed by
 * parseAccountMessage, and ends on the review screen instead of the payment
 * screen (nicknameCheck.ts confirmCustomerInputs). Premium Apps and legacy
 * null-group categories keep the per-field loop below unchanged.
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
import { hasForbiddenAccountCharacter, parseAccountMessage, type ParseAccountResult } from "@app/core/accountInput";
import { prisma, getDenominationWithProduct } from "@app/db";
import { parseInputFields } from "@app/core/playerInput";
import { InlineKeyboard } from "grammy";
import { clearPlayerInputScratch, confirmCustomerInputs } from "./nicknameCheck";
import type { MyContext, MyConversation } from "../context";
import { menuAnchor, consumeInput } from "../util/chat";
import { esc } from "../util/format";
import { coreT } from "../util/i18n";
import * as ckb from "../keyboards/customer";
import { isGameTopupGroup, renderOrderConfirmation } from "../handlers/checkout";
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

/**
 * Whether a Game Top-up unit is asked for in ONE message: every field is a
 * required text or number field. A select field needs its option buttons and
 * an optional field needs its Skip button, so a denomination with either keeps
 * the per-field loop (the parser maps one value onto every field it is given
 * and cannot skip one).
 */
export function usesAccountMessage(fields: AdditionalField[]): boolean {
  return fields.length > 0 && fields.every((f) => f.required && (f.type === AdditionalFieldType.TEXT || f.type === AdditionalFieldType.NUMBER));
}

/** A free-text field: plain text with no pattern, so a value may hold spaces. */
function isFreeTextField(field: AdditionalField): boolean {
  return field.type === AdditionalFieldType.TEXT && !field.pattern;
}

// Example digits: 9 for the first value (an account ID), 4 for each later one
// (a zone or server), clamped to the field's own length limits.
const EXAMPLE_DIGITS = "1234567890";
function exampleDigits(length: number): string {
  return EXAMPLE_DIGITS.repeat(Math.ceil(length / EXAMPLE_DIGITS.length)).slice(0, length);
}

/**
 * The example under the account prompt, e.g. "123456789 1234": one value per
 * field, separated by a space and never by parentheses. A field's placeholder
 * is used when it is a single value the field accepts as typed; otherwise the
 * value is digits of a length the field allows. Built from the field specs
 * only, so no game is hardcoded.
 */
export function accountExample(fields: AdditionalField[]): string {
  return fields
    .map((field, i) => {
      const placeholder = field.placeholder.trim();
      if (placeholder && !/[\s,:()]/.test(placeholder)) {
        try {
          if (validateFieldAnswer(field, placeholder) === placeholder) return placeholder;
        } catch {
          // Not a valid value for this field: fall back to digits.
        }
      }
      const preferred = i === 0 ? 9 : 4;
      const length = Math.min(Math.max(preferred, field.minLength ?? 1, 1), field.maxLength ?? Number.MAX_SAFE_INTEGER);
      return exampleDigits(length);
    })
    .join(" ");
}

/** A field's label in the buyer's language, HTML-escaped. */
function fieldLabel(field: AdditionalField, lang: string): string {
  return esc((field.label as Record<string, string>)[lang] ?? field.label.en);
}

/**
 * The one-message account prompt for a unit: a "Unit N of M" header only when
 * buying more than one, the fields in order, the example and the hint. An
 * error line goes on top, and the hint becomes the error hint.
 */
function accountPrompt(lang: string, unit: number, quantity: number, fields: AdditionalField[], error?: string): string {
  const parts: string[] = [];
  if (error) parts.push(error);
  if (quantity > 1) parts.push(coreT("checkout.account_unit", lang, { unit: unit + 1, total: quantity }));
  parts.push(
    coreT("checkout.account_prompt", lang, {
      fields: fields.map((f) => fieldLabel(f, lang)).join(" + "),
      example: esc(accountExample(fields)),
    }),
  );
  // One field: spaces may belong to the value, so the hint does not ask for them.
  const inputHint = fields.length === 1 ? "hint.account_input_one" : "hint.account_input";
  parts.push(coreT(error ? "hint.account_error" : inputHint, lang));
  return parts.join("\n\n");
}

/** The error line for a refused account message, naming the field when known. */
function accountError(lang: string, fields: AdditionalField[], result: Extract<ParseAccountResult, { ok: false }>): string {
  const field = fields.find((f) => f.key === result.field) ?? fields[0]!;
  switch (result.reason) {
    case "too_many":
      return coreT("checkout.account_err_too_many", lang);
    case "ambiguous":
      return coreT("checkout.account_err_ambiguous", lang);
    case "unbalanced":
      return coreT("checkout.account_err_unbalanced", lang);
    case "invalid_value":
      return coreT("checkout.account_err_invalid", lang, {
        label: fieldLabel(field, lang),
        error: coreT(result.errorKey ?? "error.field_invalid_pattern", lang, result.errorArgs),
      });
    default:
      // "empty" or "missing_field".
      return coreT("checkout.account_err_missing", lang, { label: fieldLabel(field, lang) });
  }
}

/**
 * Parse one unit's account message. A lone free-text field keeps taking the
 * whole message as its value, spaces included, as the per-field wizard did:
 * with one field nothing can be split wrongly, and an ID such as a Riot ID
 * ("Night Owl#SEA") holds a space the parser would refuse as a second value.
 */
function readAccountMessage(fields: AdditionalField[], text: string): ParseAccountResult {
  const parsed = parseLoneFreeText(fields, text) ?? parseAccountMessage(fields, text);
  if (!parsed.ok) return parsed;
  // Every value is shown back on the review screen, so none may be longer
  // than that screen can display.
  for (const field of fields) {
    if ((parsed.values[field.key] ?? "").length > MAX_ACCOUNT_VALUE_LENGTH) {
      return { ok: false, reason: "invalid_value", field: field.key, errorKey: "error.account_value_too_long", errorArgs: { max: MAX_ACCOUNT_VALUE_LENGTH } };
    }
  }
  return parsed;
}

/** The longest account value a Game Top-up buyer may type; the review screen
 *  shows each value whole, so this keeps it well inside one message. */
export const MAX_ACCOUNT_VALUE_LENGTH = 128;

/**
 * The lone free-text field path: the whole message is the value, validated by
 * the field spec and the parser's invisible-character rule. Null when the
 * parser applies instead (several fields, a typed field, or a message the
 * parser reads as one value anyway).
 */
function parseLoneFreeText(fields: AdditionalField[], text: string): ParseAccountResult | null {
  if (fields.length !== 1 || !isFreeTextField(fields[0]!)) return null;
  const parsed = parseAccountMessage(fields, text);
  if (parsed.ok || parsed.reason !== "too_many") return parsed;
  const field = fields[0]!;
  if (hasForbiddenAccountCharacter(text)) {
    return { ok: false, reason: "invalid_value", field: field.key, errorKey: "error.field_invalid_pattern", errorArgs: { key: field.key } };
  }
  try {
    return { ok: true, values: { [field.key]: validateFieldAnswer(field, text) } };
  } catch (e) {
    if (e instanceof ValidationError) return { ok: false, reason: "invalid_value", field: field.key, errorKey: e.key, errorArgs: e.formatArgs };
    throw e;
  }
}

export async function customerInfoConversation(conversation: MyConversation, ctx: MyContext): Promise<void> {
  const lang = ctx.session.lang;
  const productId = ctx.session.scratch.pendingInfoProductId as number;
  const quantity = ctx.session.scratch.pendingInfoQuantity as number;

  // A plain object, not the Prisma row: only these two values are used, and
  // the conversation's op log replays exactly what it stored.
  const product = await conversation.external(async () => {
    const d = await getDenominationWithProduct(prisma, productId);
    return { additionalFields: d?.additionalFields ?? null, group: d?.product.category.group ?? null };
  });
  const fields = parseInputFields(product.additionalFields);
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

  if (isGameTopupGroup(product.group) && usesAccountMessage(fields)) {
    await collectAccountMessages(conversation, ctx, productId, quantity, fields, answers, unitIdx);
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

    // Anchor pattern: the typed answer is deleted (only once it has been
    // judged, and saved when valid) and every retry edits the field-prompt
    // bubble instead of stacking error replies.
    if (u.callbackQuery) await u.answerCallbackQuery();

    const field = fields[fieldIdx]!;
    let value: string;
    try {
      value = validateFieldAnswer(field, text);
      // Game Top-up values are shown whole on the review screen, so typed text
      // (not a chosen option) obeys the same length cap as the one-message path.
      if (!option && isGameTopupGroup(product.group) && value.length > MAX_ACCOUNT_VALUE_LENGTH) {
        throw new ValidationError("error.account_value_too_long", { max: MAX_ACCOUNT_VALUE_LENGTH });
      }
    } catch (e) {
      if (e instanceof ValidationError) {
        if (!u.callbackQuery) await consumeInput(u);
        await menuAnchor(u, fieldPrompt(lang, unitIdx, quantity, field, e.key, e.formatArgs), fieldKb(fieldIdx));
        continue;
      }
      throw e;
    }

    currentUnit[field.key] = value;
    if (!u.callbackQuery) await consumeInput(u);
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

/**
 * Game Top-up: one message per unit holding every field in order
 * ("123456789 1234"). Every typed message is deleted once judged. A refused
 * one edits the SAME prompt bubble with the reason, the example and the error
 * hint; an accepted one moves the bubble on to the next unit, or hands off to
 * confirmCustomerInputs, which ends on the review screen. Same escapes as the
 * per-field loop: Cancel (v1:buy), /start, /cancel and the persistent labels.
 */
async function collectAccountMessages(
  conversation: MyConversation,
  ctx: MyContext,
  productId: number,
  quantity: number,
  fields: AdditionalField[],
  answers: Array<Record<string, string>>,
  firstUnit: number,
): Promise<void> {
  const lang = ctx.session.lang;
  const kb = ckb.voucherCancelKb(productId, quantity, lang);
  let unitIdx = firstUnit;
  await menuAnchor(ctx, accountPrompt(lang, unitIdx, quantity, fields), kb);

  for (;;) {
    const u = await conversation.wait();
    const data = u.callbackQuery?.data ?? "";
    if (data.startsWith("v1:buy:")) {
      await u.answerCallbackQuery();
      clearPlayerInputScratch(u);
      await startCommand(u);
      return;
    }
    if (isCmd(u, "start") || isCmd(u, "cancel")) {
      clearPlayerInputScratch(u);
      await startCommand(u);
      return;
    }
    const text = u.message?.text;
    if (!text) {
      // A stale or unknown tap: clear its spinner and keep waiting.
      if (u.callbackQuery) await u.answerCallbackQuery({ text: coreT("error.stale_screen", lang) });
      continue;
    }
    if (ckb.isPersistentLabel(text)) {
      clearPlayerInputScratch(u);
      await handleProductNumber(u);
      return;
    }

    const result = readAccountMessage(fields, text);
    await consumeInput(u);
    if (!result.ok) {
      await menuAnchor(u, accountPrompt(lang, unitIdx, quantity, fields, accountError(lang, fields, result)), kb);
      continue;
    }

    answers.push(result.values);
    unitIdx++;
    if (unitIdx < quantity) {
      await menuAnchor(u, accountPrompt(lang, unitIdx, quantity, fields), kb);
      continue;
    }
    await confirmCustomerInputs(conversation, u, productId, quantity, fields, answers);
    return;
  }
}
