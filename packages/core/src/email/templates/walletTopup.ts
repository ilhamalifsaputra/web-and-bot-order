/**
 * The "a buyer topped up their wallet" email sent to the shop owner
 * (NotificationEvent.OWNER_EMAIL_WALLET_TOPUP) — the second owner-email
 * event (after OWNER_EMAIL_ORDER_PAID) to use the shared HTML design system
 * (packages/core/src/email), rather than the plain-text-only path
 * MANUAL_ORDER_QUEUED/NEW_TICKET/TICKET_REPLY stay on.
 *
 * Unlike `renderOrderPaidEmail`, this template takes no `EmailCopy` — its
 * title/subtitle/message are fixed constants, not Settings-overridable, and
 * its subject is a hardcoded literal, never built via `buildSubject`. That's
 * deliberate: `sendMail` (packages/core/src/mailer.ts) logs the subject on
 * every send, and per that file's SUBJECT-LINE CONSTRAINT note,
 * OWNER_EMAIL_ORDER_PAID is the ONE approved exception allowed to
 * interpolate anything (its {shop_name}/{order_code} tokens) into a subject.
 * Every other OWNER_EMAIL_* event — this one included — must keep its
 * subject a fixed string with zero interpolation, so this template doesn't
 * even expose the machinery (an EmailCopy/buildSubject call) that would make
 * that mistake possible later.
 */
import { renderShell } from "../layout";
import { eventBanner, infoTable, footer, TEXT } from "../components";
import { ptSection, ptKeyValue, ptDivider } from "../plaintext";
import { escapeHtml } from "../escape";
import type { BrandConfig, RenderedEmail } from "../types";

/** Fixed, non-interpolated subject — see this file's header. */
const SUBJECT = "Wallet Top-Up Received";
const TITLE = "A wallet was topped up";
const SUBTITLE = "A buyer just credited their wallet balance.";
const MESSAGE = "Here are the details.";

export interface WalletTopupInput {
  orderCode: string;
  customerLabel: string;
  /** Already display-formatted by the caller (e.g. via `formatMoney`) — this
   * template renders it verbatim. */
  amount: string;
  currency: string;
  /** Already display-formatted by the caller (e.g. via `formatMoney`) —
   * this template renders it verbatim. */
  newBalance: string;
  paymentMethod: string;
  transactionId: string | null;
  /** Already display-formatted by the caller — this template renders it
   * verbatim, same convention as `orderPaid.ts`'s `paidAt`. */
  toppedUpAt: string;
}

export function renderWalletTopupEmail(input: WalletTopupInput, brand: BrandConfig): RenderedEmail {
  const summaryRows = [
    { label: "Order", value: input.orderCode },
    { label: "Customer", value: input.customerLabel },
    { label: "Amount Credited", value: input.amount },
    { label: "New Balance", value: input.newBalance },
    { label: "Payment Method", value: input.paymentMethod },
    { label: "Transaction ID", value: input.transactionId ?? "" },
    { label: "Credited At", value: input.toppedUpAt },
  ];

  const bodyHtml = `
    ${eventBanner("💰", TITLE, SUBTITLE, "success")}
    <div class="email-text" style="font-size:15px;color:${TEXT};line-height:1.6;margin-bottom:24px;">${escapeHtml(MESSAGE)}</div>
    ${infoTable(summaryRows)}
    ${footer(brand, { generatedByLine: "This is an automated notification — no reply needed." })}
  `;

  const html = renderShell({
    brand,
    bodyHtml,
    preheader: `Wallet Top-Up Received - ${input.orderCode}`,
  });

  const text = [
    ptSection(TITLE),
    SUBTITLE,
    "",
    MESSAGE,
    "",
    ptDivider(),
    ptSection("Top-Up Summary"),
    ptKeyValue("Order", input.orderCode),
    ptKeyValue("Customer", input.customerLabel),
    ptKeyValue("Amount Credited", input.amount),
    ptKeyValue("New Balance", input.newBalance),
    ptKeyValue("Payment Method", input.paymentMethod),
    ...(input.transactionId ? [ptKeyValue("Transaction ID", input.transactionId)] : []),
    ptKeyValue("Credited At", input.toppedUpAt),
    "",
    ptDivider(),
    "This is an automated notification — no reply needed.",
  ].join("\n");

  return { subject: SUBJECT, html, text };
}
