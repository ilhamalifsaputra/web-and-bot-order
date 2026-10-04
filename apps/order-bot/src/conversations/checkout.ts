/**
 * Checkout conversation — the voucher-entry ConversationHandler from
 * checkout.py.
 *
 * Replay-safety: DB reads that precede a further wait() are wrapped in
 * conversation.external(); terminal mutations (followed by return, no more
 * waits) run once and may call handler helpers directly.
 */
import { Decimal } from "@app/core/money";
import { ValidationError } from "@app/core/errors";
import { prisma, getVoucherByCode, applyVoucherToSubtotal } from "@app/db";
import type { MyContext, MyConversation } from "../context";
import { smartEdit, menuAnchor, consumeInput } from "../util/chat";
import { coreT, t } from "../util/i18n";
import { ctxPriceFormatter, displayValidationArgs } from "../util/format";
import { currentUsdtRate } from "../util/rate";
import * as ckb from "../keyboards/customer";
import { renderOrderConfirmation } from "../handlers/checkout";
import { startCommand, handleProductNumber } from "../handlers/customer";

function isCmd(ctx: MyContext, cmd: string): boolean {
  const text = ctx.message?.text ?? "";
  return text === `/${cmd}` || text.startsWith(`/${cmd} `) || text.startsWith(`/${cmd}@`);
}

// ===========================================================================
// Voucher: Apply Voucher → enter code → validate → re-render confirmation
// ===========================================================================

export async function voucherConversation(conversation: MyConversation, ctx: MyContext): Promise<void> {
  const lang = ctx.session.lang;
  const parts = (ctx.callbackQuery?.data ?? "").split(":");
  const productId = parseInt(parts[3]!, 10);
  const qty = parseInt(parts[4]!, 10);

  await ctx.answerCallbackQuery();
  await smartEdit(ctx, t(ctx, "checkout.enter_voucher"), ckb.voucherCancelKb(productId, qty, lang));

  for (;;) {
    const u = await conversation.wait();
    const data = u.callbackQuery?.data ?? "";
    if (data.startsWith("v1:buy:")) {
      // voucher_cancel_kb routes to v1:buy — let the router re-render confirmation.
      await u.answerCallbackQuery();
      await renderOrderConfirmation(u, productId, qty);
      return;
    }
    if (isCmd(u, "start")) {
      await startCommand(u);
      return;
    }
    if (isCmd(u, "cancel")) {
      await renderOrderConfirmation(u, productId, qty);
      return;
    }
    const text = u.message?.text;
    if (!text) continue;
    if (ckb.isPersistentLabel(text)) {
      await handleProductNumber(u);
      return;
    }

    const rawCode = text.trim().toUpperCase();
    // Anchor pattern: the typed code is deleted and every retry edits the
    // voucher-prompt bubble instead of stacking error replies.
    await consumeInput(u);
    const promptAgain = (errKey: string, args: Record<string, unknown> = {}) =>
      `${coreT(errKey, lang, args)}\n\n${coreT("checkout.enter_voucher", lang)}`;

    if (!rawCode || rawCode.length > 32) {
      await menuAnchor(u, promptAgain("error.invalid_voucher_code"), ckb.voucherCancelKb(productId, qty, lang));
      continue;
    }

    const voucher = await conversation.external(() => getVoucherByCode(prisma, rawCode));
    if (voucher === null) {
      await menuAnchor(u, promptAgain("error.voucher_not_found"), ckb.voucherCancelKb(productId, qty, lang));
      continue;
    }
    try {
      // A coarse "is the code fundamentally live" gate only (active, started,
      // not expired, not used up). It passes a subtotal taken from the
      // voucher itself — its own minimum purchase, at least 1 — so the
      // min_purchase check can never trip here whatever that minimum is (a
      // fixed sentinel such as Rp999.999 refused every voucher with a higher
      // minimum, money audit C15), and the same positive value as the
      // eligible subtotal so a SELECTED-scope voucher's not-applicable check
      // doesn't trip either. The authoritative checks against the real order
      // — minimum purchase and per-product scope — happen moments later in
      // renderOrderConfirmation -> computeConfirmation, which surfaces
      // error.voucher_min_purchase / error.voucher_not_applicable there.
      const coarseSubtotal = Decimal.max(new Decimal(voucher.minPurchase), 1);
      applyVoucherToSubtotal(voucher, coarseSubtotal, coarseSubtotal);
    } catch (e) {
      if (e instanceof ValidationError) {
        // A minimum purchase is IDR-canonical — show it in the buyer's display
        // currency. The rate read is DB I/O before a further wait(), so it
        // runs in external(); only the plain formatted args are replayed.
        const args = await conversation.external(async () =>
          displayValidationArgs(e.key, e.formatArgs, ctxPriceFormatter(u, await currentUsdtRate())),
        );
        await menuAnchor(u, promptAgain(e.key, args), ckb.voucherCancelKb(productId, qty, lang));
        continue;
      }
      throw e;
    }

    u.session.scratch.appliedVoucherCode = rawCode;
    await renderOrderConfirmation(u, productId, qty);
    return;
  }
}
