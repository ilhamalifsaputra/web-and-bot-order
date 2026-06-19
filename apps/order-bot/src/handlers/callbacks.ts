/**
 * Central callback-query router — port of callbacks.py.
 *
 * Every inline-button press whose data starts with `v1:` lands here (the proof
 * and voucher conversations intercept their own taps first via the
 * conversations plugin). We split `v1:<domain>:<action>[:args...]` and dispatch
 * through a domain-keyed table. The `adm:` domain delegates to the admin
 * sub-router (which applies its own admin-gate guard).
 */
import { config } from "@app/core/config";
import { adminIds } from "@app/core/runtime";
import { TicketStatus } from "@app/core/enums";
import { logger } from "@app/core/logger";
import {
  prisma,
  getTicket,
  closeTicket,
} from "@app/db";
import type { MyContext } from "../context";
import { smartEdit } from "../util/chat";
import { t } from "../util/i18n";
import { logErrorRef } from "../util/errors";
import * as ckb from "../keyboards/customer";
import * as customer from "./customer";
import * as checkout from "./checkout";
import * as staticPages from "./static";
import { handleAdminCallback } from "./admin";

type Parts = string[];
type DomainDispatcher = (ctx: MyContext, parts: Parts) => Promise<void>;

// ---------------------------------------------------------------------------
// Per-domain dispatchers
// ---------------------------------------------------------------------------

const dispatchNoop: DomainDispatcher = async () => {};

const dispatchMenu: DomainDispatcher = async (ctx, parts) => {
  if (parts[2] === "main") await customer.showMainMenu(ctx);
};

const dispatchBrowse: DomainDispatcher = async (ctx, parts) => {
  // prods/page → flat Product list; prod → a Product's denomination picker;
  // denom → a Denomination detail bubble. The pre-rename `group` action was
  // renamed to `prod` (and the old `prod`, which meant a SKU, to `denom`); an
  // old in-flight bubble carrying `v1:browse:group:*` therefore lands in the
  // default branch below and degrades to the stale-screen toast, never a crash.
  const action = parts[2];
  if (action === "prods") await customer.browseProductsFlat(ctx);
  else if (action === "page") await customer.browseProductsFlat(ctx, parseInt(parts[3]!, 10));
  else if (action === "prod") await customer.browseProduct(ctx, parseInt(parts[3]!, 10));
  else if (action === "denom") await customer.browseDenomination(ctx, parseInt(parts[3]!, 10));
  else {
    logger.warn({ event: "dead_tap", action, callbackData: ctx.callbackQuery?.data, userId: ctx.from?.id }, "stale browse callback");
    await ctx.answerCallbackQuery({ text: t(ctx, "error.stale_screen") });
  }
};

const dispatchQty: DomainDispatcher = async (ctx, parts) => {
  // v1:qty:input:<pid> | v1:qty:cancel:<pid> | v1:qty:<pid>:<qty>:<inc|dec>
  if (parts[2] === "input") await customer.qtyInputStart(ctx, parseInt(parts[3]!, 10));
  else if (parts[2] === "cancel") await customer.qtyInputCancel(ctx, parseInt(parts[3]!, 10));
  else await customer.qtyChange(ctx, parseInt(parts[2]!, 10), parseInt(parts[3]!, 10), parts[4]!);
};

const dispatchBuy: DomainDispatcher = async (ctx, parts) => {
  // v1:buy:<pid>:<qty> → confirmation screen
  await checkout.showOrderConfirmation(ctx, parseInt(parts[2]!, 10), parseInt(parts[3]!, 10));
};

const dispatchPay: DomainDispatcher = async (ctx, parts) => {
  // v1:pay:<pid>:<qty> → Binance Pay order (manual proof)
  await checkout.buyNow(ctx, parseInt(parts[2]!, 10), parseInt(parts[3]!, 10));
};

const dispatchUsdt: DomainDispatcher = async (ctx, parts) => {
  // v1:usdt:<pid>:<qty> → USDT payment submenu (Binance Transfer / Bybit)
  await checkout.showUsdtMethods(ctx, parseInt(parts[2]!, 10), parseInt(parts[3]!, 10));
};

const dispatchPayInternal: DomainDispatcher = async (ctx, parts) => {
  // v1:payx:<pid>:<qty> → Binance Internal Transfer (auto-confirmed)
  await checkout.buyNowInternal(ctx, parseInt(parts[2]!, 10), parseInt(parts[3]!, 10));
};

const dispatchPayBybit: DomainDispatcher = async (ctx, parts) => {
  // v1:payb:<pid>:<qty> → Bybit USDT-BSC deposit (auto-confirmed)
  await checkout.buyNowBybit(ctx, parseInt(parts[2]!, 10), parseInt(parts[3]!, 10));
};

const dispatchPayTokopay: DomainDispatcher = async (ctx, parts) => {
  // v1:payq:<pid>:<qty> → QRIS (TokoPay) order (auto-confirmed by webhook)
  await checkout.buyNowTokopay(ctx, parseInt(parts[2]!, 10), parseInt(parts[3]!, 10));
};

const dispatchVoucher: DomainDispatcher = async (ctx, parts) => {
  // v1:voucher:remove:<pid>:<qty>  (voucher:start is owned by the voucher conv)
  if (parts[2] === "remove") {
    delete ctx.session.scratch.appliedVoucherCode;
    await checkout.showOrderConfirmation(ctx, parseInt(parts[3]!, 10), parseInt(parts[4]!, 10));
  }
};

const dispatchCheckout: DomainDispatcher = async (ctx, parts) => {
  const action = parts[2];
  if (action === "cancel") await checkout.cancelPendingOrder(ctx, parseInt(parts[3]!, 10));
  // checkout:proof is the entry point for the proof conversation (handled by
  // the conversations plugin). It only reaches here if the conversation didn't
  // capture it — in that case re-entry is handled by the conversation itself.
};

const dispatchOrder: DomainDispatcher = async (ctx, parts) => {
  const action = parts[2];
  if (action === "list") await customer.listMyOrders(ctx);
  else if (action === "page") await customer.listMyOrders(ctx);
  else if (action === "view") await customer.viewOrder(ctx, parseInt(parts[3]!, 10));
  else if (action === "allhistory") await customer.allOrderHistory(ctx);
};

const dispatchRef: DomainDispatcher = async (ctx, parts) => {
  if (parts[2] === "view") await customer.viewReferral(ctx);
};

const dispatchLang: DomainDispatcher = async (ctx, parts) => {
  const action = parts[2];
  if (action === "menu") await customer.showLanguageMenu(ctx);
  else if (action === "set") await customer.setLanguage(ctx, parts[3]!);
};

const dispatchTicket: DomainDispatcher = async (ctx, parts) => {
  // user-side ticket management; 'reply' is owned by the ticket-reply conv
  const action = parts[2];
  if (action === "list") await customer.listMyTickets(ctx);
  else if (action === "view") await customer.viewMyTicket(ctx, parseInt(parts[3]!, 10));
  else if (action === "close") await closeTicketUser(ctx, parseInt(parts[3]!, 10));
};

const dispatchRestock: DomainDispatcher = async (ctx, parts) => {
  if (parts[2] === "sub") await customer.subscribeRestock(ctx, parseInt(parts[3]!, 10));
};

const dispatchPage: DomainDispatcher = async (ctx, parts) => {
  const action = parts[2];
  if (action === "faq") await staticPages.showFaq(ctx);
  else if (action === "terms") await staticPages.showTerms(ctx);
  else if (action === "howtopay") await staticPages.showHowtopay(ctx);
};

const DOMAIN_ROUTES: Record<string, DomainDispatcher> = {
  browse: dispatchBrowse,
  buy: dispatchBuy,
  checkout: dispatchCheckout,
  lang: dispatchLang,
  menu: dispatchMenu,
  noop: dispatchNoop,
  order: dispatchOrder,
  page: dispatchPage,
  pay: dispatchPay,
  usdt: dispatchUsdt,
  payx: dispatchPayInternal,
  payb: dispatchPayBybit,
  payq: dispatchPayTokopay,
  qty: dispatchQty,
  ref: dispatchRef,
  restock: dispatchRestock,
  ticket: dispatchTicket,
  voucher: dispatchVoucher,
};

// ---------------------------------------------------------------------------
// Top-level router
// ---------------------------------------------------------------------------

export async function routeCallback(ctx: MyContext): Promise<void> {
  const cq = ctx.callbackQuery;
  if (!cq || !cq.data) return;

  const parts = cq.data.split(":");
  if (parts.length < 2 || parts[0] !== "v1") {
    // A button from an old bubble whose format we no longer speak — tell the
    // user the screen expired instead of silently swallowing the tap.
    logger.warn({ event: "dead_tap", callbackData: cq.data, userId: ctx.from?.id }, "stale callback (non-v1 format)");
    await ctx.answerCallbackQuery({ text: t(ctx, "error.stale_screen") });
    return;
  }

  const domain = parts[1];

  // Quantity-input mode (awaitingQtyProductId) is a text-capture state: any
  // inline-button tap means the user navigated away by button, so the mode must
  // end here — otherwise a number typed later is misread as a quantity (§8.9).
  // smartEdit already clears it on every screen render; this is the structural
  // guarantee for callbacks that *don't* end on smartEdit (toasts, downloads).
  // The one exception is the button that *starts* the mode (qty:input), which
  // sets the flag itself just after rendering its prompt.
  if (!(domain === "qty" && parts[2] === "input")) {
    ctx.session.awaitingQtyProductId = undefined;
  }

  if (domain === "adm") {
    try {
      await ctx.answerCallbackQuery();
    } catch {
      /* already answered */
    }
    await handleAdminCallback(ctx, parts);
    return;
  }

  const dispatcher = DOMAIN_ROUTES[domain!];
  if (dispatcher === undefined) {
    logger.warn({ event: "dead_tap", domain, callbackData: cq.data, userId: ctx.from?.id }, "stale callback (unknown domain)");
    try {
      await ctx.answerCallbackQuery({ text: t(ctx, "error.stale_screen") });
    } catch {
      /* ignore */
    }
    return;
  }

  try {
    await dispatcher(ctx, parts);
    try {
      await ctx.answerCallbackQuery();
    } catch {
      /* a dispatcher may have already answered */
    }
  } catch (err) {
    // Catch-all for any dispatcher crash — log under a ref and quote it so a
    // customer report maps straight to the stack trace (§8.6).
    const ref = logErrorRef(err, `Router error for callback_data=${cq.data}`);
    try {
      await ctx.answerCallbackQuery({ text: t(ctx, "error.generic_ref", { ref }), show_alert: true });
    } catch {
      logger.error(`Failed to deliver error popup for callback_data=${cq.data} ref=${ref}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Inline helpers used by the router
// ---------------------------------------------------------------------------

async function closeTicketUser(ctx: MyContext, ticketId: number): Promise<void> {
  const info = ctx.session.dbUser!;
  const ticket = await getTicket(prisma, ticketId);
  if (ticket === null || ticket.userId !== info.id) {
    await ctx.answerCallbackQuery({ text: t(ctx, "error.order_not_found"), show_alert: true });
    return;
  }
  if (ticket.status === TicketStatus.CLOSED) {
    await ctx.answerCallbackQuery({ text: t(ctx, "support.already_closed"), show_alert: true });
    return;
  }
  await closeTicket(prisma, ticketId);

  await ctx.answerCallbackQuery({ text: t(ctx, "support.ticket_closed_user") });
  // Edit the ticket bubble into a closed-confirmation (with navigation) rather
  // than just stripping its buttons and relying on the ephemeral toast.
  await smartEdit(ctx, t(ctx, "support.ticket_closed_user"), ckb.ticketClosedKb(ctx.session.lang));

  const targets = config.SUPPORT_GROUP_ID ? [config.SUPPORT_GROUP_ID] : adminIds();
  for (const chatId of targets) {
    if (!chatId) continue;
    try {
      await ctx.api.sendMessage(
        chatId,
        `✅ Ticket #${ticketId} marked as resolved by user <code>${ctx.from!.id}</code>.`,
        { parse_mode: "HTML" },
      );
    } catch (err) {
      logger.error({ err }, "Failed to notify admin about ticket close");
    }
  }
}
