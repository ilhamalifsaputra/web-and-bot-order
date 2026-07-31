/**
 * Edit-info conversation — lets a buyer correct their manual_with_info
 * checkout answers while the order is still PROCESSING (paid, awaiting
 * hand-fulfilment). Entered programmatically from callbacks.ts's dispatchOrder
 * (v1:order:editinfo:<id> — see conversations/index.ts) once per tap; the
 * target order id rides in ctx.session.scratch.editInfoOrderId (conversations
 * can't take entry args in this codebase, same as customerInfo's
 * pendingInfoProductId, Task 5).
 *
 * Structurally mirrors customerInfo.ts's wizard (menuAnchor prompts,
 * consumeInput on the typed reply, re-prompt the SAME bubble on a validation
 * error, /start/​/cancel/persistent-label escapes, per-unit×field loop) but is
 * a SEPARATE file — customerInfo.ts is checkout-flow-coupled and out of scope
 * here. Two differences from customerInfo.ts:
 *   - Every field is pre-seeded with its current answer, shown in the prompt,
 *     with a new /skip escape that carries it forward unchanged so the buyer
 *     isn't forced to retype an already-correct answer.
 *   - On completion this calls updateOrderCustomerData (NOT the checkout
 *     path) and returns to viewOrder — it never touches checkout scratch or
 *     navigates to payment.
 *
 * Mid-edit race: the order can leave PROCESSING between entry and completion
 * (e.g. an admin fulfils it while the buyer is mid-edit). Guarded once at
 * entry (before the first prompt) and again by updateOrderCustomerData itself
 * at the final write (throws ValidationError "error.order_not_processing") —
 * both paths show that error and land back on viewOrder's live current state
 * rather than silently losing the buyer's edits or corrupting a delivered order.
 */
import { ValidationError } from "@app/core/errors";
import { OrderStatus } from "@app/core/enums";
import {
  AdditionalFieldType,
  parseAdditionalFields,
  parseCustomerData,
  validateFieldAnswer,
  type AdditionalField,
} from "@app/core/deliveryFields";
import { prisma, getOrder, updateOrderCustomerData } from "@app/db";
import type { MyContext, MyConversation } from "../context";
import { menuAnchor, consumeInput } from "../util/chat";
import { esc } from "../util/format";
import { coreT } from "../util/i18n";
import * as ckb from "../keyboards/customer";
import { startCommand, handleProductNumber, viewOrder } from "../handlers/customer";

function isCmd(ctx: MyContext, cmd: string): boolean {
  const text = ctx.message?.text ?? "";
  return text === `/${cmd}` || text.startsWith(`/${cmd} `) || text.startsWith(`/${cmd}@`);
}

/** Render one field's prompt, with a running "Unit N of M" header, the
 * buyer's current answer (if any, so they can /skip instead of retyping), and
 * an optional validation-error line prepended. Mirrors customerInfo.ts's
 * fieldPrompt helper plus the current-value line. */
function fieldPrompt(
  lang: string,
  unit: number,
  quantity: number,
  field: AdditionalField,
  currentValue: string | undefined,
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
  if (currentValue) {
    body += "\n" + coreT("order.edit_info_current_value", lang, { value: esc(currentValue) });
  }
  return errorKey ? `${coreT(errorKey, lang, errorArgs)}\n\n${body}` : body;
}

export async function editCustomerInfoConversation(conversation: MyConversation, ctx: MyContext): Promise<void> {
  const lang = ctx.session.lang;
  const orderId = ctx.session.scratch.editInfoOrderId as number;
  const userId = ctx.session.dbUser!.id;

  const order = await conversation.external(() => getOrder(prisma, orderId));
  if (!order || order.userId !== userId) {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: coreT("error.order_not_found", lang), show_alert: true });
    }
    return viewOrder(ctx, orderId);
  }
  if (order.status !== OrderStatus.PROCESSING) {
    // The race this wizard guards against: an admin fulfilled (or the order
    // otherwise left PROCESSING) between the Edit-Info tap and this read.
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: coreT("error.order_not_processing", lang), show_alert: true });
    }
    return viewOrder(ctx, orderId);
  }

  const fields = parseAdditionalFields(order.items[0]?.product.additionalFields ?? null);
  const quantity = order.items.length;
  if (fields.length === 0) {
    // Defensive — shouldn't normally happen for a manual_with_info SKU with no
    // fields configured. Nothing to edit; go straight back.
    return viewOrder(ctx, orderId);
  }
  const existingAnswers = parseCustomerData(order.customerData);
  const cancelKb = ckb.editInfoCancelKb(orderId, lang);

  if (ctx.callbackQuery) await ctx.answerCallbackQuery();
  await menuAnchor(
    ctx,
    fieldPrompt(lang, 0, quantity, fields[0]!, existingAnswers[0]?.[fields[0]!.key]),
    cancelKb,
  );

  const answers: Array<Record<string, string>> = [];
  let currentUnit: Record<string, string> = {};
  let unitIdx = 0;
  let fieldIdx = 0;

  for (;;) {
    const u = await conversation.wait();
    const data = u.callbackQuery?.data ?? "";
    if (data.startsWith("v1:order:view:")) {
      // editInfoCancelKb routes to v1:order:view — abandon editing, no changes
      // saved, and land on the order-detail screen it points at.
      await u.answerCallbackQuery();
      return viewOrder(u, orderId);
    }
    if (isCmd(u, "start")) {
      await startCommand(u);
      return;
    }
    if (isCmd(u, "cancel")) {
      return viewOrder(u, orderId);
    }
    const text = u.message?.text;
    if (!text) {
      // An inline tap that doesn't match v1:order:view: (e.g. a stale/duplicate
      // tap) — clear its spinner instead of leaving it hanging (M-22 fix).
      if (u.callbackQuery) await u.answerCallbackQuery({ text: coreT("error.stale_screen", lang) });
      continue;
    }
    if (ckb.isPersistentLabel(text)) {
      await handleProductNumber(u);
      return;
    }

    // Anchor pattern: the typed answer is deleted and every retry edits the
    // field-prompt bubble instead of stacking error replies.
    await consumeInput(u);

    const field = fields[fieldIdx]!;
    const currentValue = existingAnswers[unitIdx]?.[field.key];
    let value: string;
    if (isCmd(u, "skip")) {
      if (!currentValue) {
        if (!field.required) {
          // Optional field with nothing to carry forward — /skip legitimately
          // leaves it blank, same as leaving it blank would have at checkout.
          value = validateFieldAnswer(field, "");
        } else {
          // Nothing to carry forward — same re-prompt shape a validation error
          // would produce, reusing the existing required-field copy.
          await menuAnchor(
            u,
            fieldPrompt(lang, unitIdx, quantity, field, currentValue, "error.field_required", { key: field.key }),
            cancelKb,
          );
          continue;
        }
      } else {
        // Carry the prior answer forward, but re-validate it against the
        // field's CURRENT spec instead of trusting it raw — an admin may have
        // narrowed a select's options (or otherwise tightened the spec)
        // between the original checkout answer and this edit, and a stale
        // answer that no longer satisfies it must re-prompt like any other
        // validation error, not silently persist (Finding #10,
        // per-sku-delivery-flows audit 2026-07-13).
        try {
          value = validateFieldAnswer(field, currentValue);
        } catch (e) {
          if (e instanceof ValidationError) {
            await menuAnchor(
              u,
              fieldPrompt(lang, unitIdx, quantity, field, currentValue, e.key, e.formatArgs),
              cancelKb,
            );
            continue;
          }
          throw e;
        }
      }
    } else {
      try {
        value = validateFieldAnswer(field, text);
      } catch (e) {
        if (e instanceof ValidationError) {
          await menuAnchor(
            u,
            fieldPrompt(lang, unitIdx, quantity, field, currentValue, e.key, e.formatArgs),
            cancelKb,
          );
          continue;
        }
        throw e;
      }
    }

    currentUnit[field.key] = value;
    fieldIdx++;
    if (fieldIdx < fields.length) {
      await menuAnchor(
        u,
        fieldPrompt(lang, unitIdx, quantity, fields[fieldIdx]!, existingAnswers[unitIdx]?.[fields[fieldIdx]!.key]),
        cancelKb,
      );
      continue;
    }

    // This unit's answers are complete.
    answers.push(currentUnit);
    currentUnit = {};
    fieldIdx = 0;
    unitIdx++;
    if (unitIdx < quantity) {
      await menuAnchor(
        u,
        fieldPrompt(lang, unitIdx, quantity, fields[0]!, existingAnswers[unitIdx]?.[fields[0]!.key]),
        cancelKb,
      );
      continue;
    }

    // All quantity × fields.length answers collected — persist, guarding
    // against the order having left PROCESSING while the buyer was editing,
    // AND against updateOrderCustomerData's own re-validation rejecting the
    // answers (e.g. error.field_invalid_select from a spec that changed
    // mid-edit) — only the former is a genuine lock-out; the latter must let
    // the buyer retry instead of crashing the conversation (Finding #10,
    // per-sku-delivery-flows audit 2026-07-13).
    try {
      await conversation.external(() => updateOrderCustomerData(prisma, orderId, answers));
    } catch (e) {
      if (e instanceof ValidationError) {
        if (e.key === "error.order_not_processing") {
          // The race this wizard guards against, caught at the very last step
          // instead of entry: an admin fulfilled the order while the buyer was
          // mid-edit. u has no callbackQuery here (it's the final typed answer),
          // so this edits the wizard's anchor bubble into the error, then
          // viewOrder sends a fresh message showing the order's real current
          // state — the buyer sees both, never a silently-dropped edit.
          await menuAnchor(u, coreT("error.order_not_processing", lang));
          await viewOrder(u, orderId);
          return;
        }
        // Any other validation failure — editing is NOT locked, so let the
        // buyer retry rather than crash the wizard: restart the per-unit
        // collection from the top (fields[0] of unit 0), showing the error
        // above the re-prompt in the same anchor bubble.
        answers.length = 0;
        currentUnit = {};
        fieldIdx = 0;
        unitIdx = 0;
        await menuAnchor(
          u,
          fieldPrompt(lang, 0, quantity, fields[0]!, existingAnswers[0]?.[fields[0]!.key], e.key, e.formatArgs),
          cancelKb,
        );
        continue;
      }
      throw e;
    }
    return viewOrder(u, orderId);
  }
}
