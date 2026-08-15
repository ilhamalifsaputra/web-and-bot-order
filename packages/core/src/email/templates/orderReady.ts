/**
 * The buyer-facing "your order is ready" email
 * (NotificationEvent.BUYER_EMAIL_ORDER_READY) — sent to a guest shopper's own
 * inbox when their order actually completes.
 *
 * THIS IS NOT AN OWNER EMAIL. Every other template in this folder that
 * renders an order (orderPaid.ts, walletTopup.ts) is addressed to the shop
 * owner, resolves its recipient from Settings, and can afford to assume a
 * trusted reader. This one is addressed to a customer whose recipient address
 * came straight from the checkout form. Do not "tidy" it onto the owner-email
 * path (resolveOwnerEmailRecipient / an owner_email_on_* toggle) — it has no
 * owner toggle by design, because a buyer being told their order is done is
 * not a notification the shop opts into.
 *
 * NO CREDENTIALS, NO ATTACHMENTS. The input type deliberately has no field
 * for delivered content, and must never gain one: email is unencrypted and
 * sits in an inbox forever, so what the buyer bought is read on the order
 * page, never mailed. Same rule stated at `sendGuestOrderCodeEmail` in
 * apps/storefront/src/routes/api.ts.
 *
 * THREE WAYS BACK IN, NOT ONE. The primary button points at the order page,
 * which for a guest is reachable only while their 30-day session cookie
 * lives. A reader on a new device, or past that window, would hit a login
 * wall they can never pass (guests have no password). So the body ALSO
 * prints the order code and links to `/track`, which trades that code back
 * for a session — the same belt-and-braces structure
 * `sendGuestOrderCodeEmail` uses. Dropping either fallback strands exactly
 * the readers who need this email most.
 *
 * FIXED SUBJECT, AND A CODE-FREE PREHEADER. Like walletTopup.ts this
 * template takes no `EmailCopy` and never calls `buildSubject`: the subject
 * is a hardcoded literal with zero interpolation. The stakes are higher here
 * than for any OWNER_EMAIL_* event — for a guest order the order code IS the
 * full credential (POST /api/v1/track swaps it for a session), `sendMail`
 * logs every subject it sends, and subject + preheader are what render in a
 * lock-screen notification preview. So neither the subject NOR the
 * `renderShell` preheader may carry the order code; it appears only in the
 * body, where the buyer actually reads it.
 */
import { renderShell } from "../layout";
import {
  eventBanner,
  infoTable,
  primaryButton,
  fallbackLinkLine,
  footer,
  divider,
  TEXT,
  MUTED,
} from "../components";
import { ptSection, ptKeyValue, ptDivider } from "../plaintext";
import { escapeHtml } from "../escape";
import type { BrandConfig, RenderedEmail } from "../types";

/** Fixed, non-interpolated subject — see this file's header. Bilingual in one
 * line, matching the bilingual body: an email has no session to read a
 * language preference from. */
const SUBJECT = "Your order is ready — Pesanan kamu sudah siap";
/** Preheader deliberately repeats the subject rather than adding the order
 * code (which walletTopup.ts's preheader does, safely, because its reader is
 * the shop owner) — see this file's header. */
const PREHEADER = "Your order is ready — Pesanan kamu sudah siap";

const EN_HEADING = "Your order is ready";
const EN_SUBHEADING = "Everything you bought has been delivered to your order page.";
const EN_BODY =
  "Thank you for your order. It is complete — open your order page to read what you bought. " +
  "For your security, what you bought is never sent by email; you read it on the order page.";
const ID_HEADING = "Pesanan kamu sudah siap";
const ID_BODY =
  "Terima kasih atas pesanan kamu. Pesanan ini sudah selesai — buka halaman pesanan untuk melihat barang yang kamu beli. " +
  "Demi keamanan, barang yang kamu beli tidak pernah dikirim lewat email; kamu membacanya di halaman pesanan.";

const EN_CODE_NOTE =
  "Keep this email safe. Your order code below is the only way back into this order, so treat it like a password.";
const ID_CODE_NOTE =
  "Simpan email ini baik-baik. Kode pesanan di bawah adalah satu-satunya cara masuk kembali ke pesanan ini, jadi perlakukan seperti kata sandi.";

const EN_TRACK_NOTE = "Lost this browser, or on another device? Reopen your order with the code above:";
const ID_TRACK_NOTE = "Browser ini hilang, atau kamu pindah perangkat? Buka lagi pesanan kamu pakai kode di atas:";

// The banner heading, summary labels, and button text are the parts of the
// email a buyer actually scans first — unlike the prose paragraphs above
// (already bilingual, EN block then ID block), these are single elements
// with no room for two separate blocks, so each carries both languages
// merged into one compact "EN / ID" string.
const BANNER_HEADING = `${EN_HEADING} / ${ID_HEADING}`;
const LABEL_SUBTOTAL = "Subtotal / Subtotal";
const LABEL_DISCOUNT = "Discount / Diskon";
/** "Kode unik" is the everyday Indonesian term for the few-digit surcharge a
 * transfer/QRIS payment carries so the shop can tell two identical payments
 * apart — the reader already knows what this row is. */
const LABEL_UNIQUE_CODE = "Unique code / Kode unik";
const LABEL_TOTAL = "Total / Total";
const LABEL_WARRANTY = "Warranty / Garansi";
const BUTTON_LABEL = "View Your Order / Lihat Pesanan";

export interface OrderReadyItem {
  name: string;
  variant: string | null;
  quantity: number;
  /** Already display-formatted by the caller (e.g. via `formatMoney`) — this
   * template renders it verbatim, same convention as `orderPaid.ts`. */
  unitPrice: string;
  /** The whole line's money, already display-formatted by the caller (via
   * `Decimal`, never float arithmetic) and rendered verbatim. Required so the
   * item line can show a line total next to the unit price — without it, a
   * multi-quantity line reads as if the printed figure were the line total
   * when it is actually the per-unit price.
   *
   * NOT necessarily `unitPrice * quantity`, and this template must never
   * compute it that way: on a currency-converted order the caller's
   * `unitPrice` is already rounded to the nearest 0.1 USDT, and the caller
   * derives this from the unrounded line instead. */
  lineTotal: string;
}

export interface OrderReadyInput {
  orderCode: string;
  items: OrderReadyItem[];
  /** Already display-formatted by the caller — rendered verbatim. */
  subtotal: string;
  /** Already display-formatted by the caller, or `""` for a zero discount —
   * an empty string hides the Discount row/line entirely, same convention as
   * `orderPaid.ts`. */
  discount: string;
  /** The order's unique-cents surcharge, already display-formatted by the
   * caller, or `""` to hide the row (the same convention `discount` uses).
   *
   * It is NOT decoration: on a USDT order `finalizeOrderPayment` adds
   * 0.002-0.098 USDT of deterministic noise to the total so the payment
   * poller can match the buyer's transfer by amount. That surcharge is money
   * the buyer actually paid, and while it went unprinted this receipt could
   * not add up no matter how carefully the other figures were rounded. The
   * caller hides the row only when it is worth zero AT THE PRECISION THIS
   * RECEIPT PRINTS — a row that would read "0.00" contributes exactly nothing
   * to the printed total, so hiding it keeps the arithmetic true rather than
   * breaking it. */
  uniqueCode: string;
  /** Already display-formatted by the caller — rendered verbatim.
   *
   * Subtotal - Discount + Unique code must equal this, exactly, on the
   * printed digits: the reader is the customer who just paid, and a summary
   * that does not reconcile reads as an overcharge. The caller owns that
   * guarantee (see enqueueBuyerOrderReadyEmailIfGuest in
   * packages/db/src/crud/orders.ts); this template only lays the figures out
   * and must never recompute one from the others. */
  total: string;
  /** Already display-formatted by the caller (e.g. "30 days / 30 hari"), or
   * null when the order carries no warranty — null hides the row/line
   * entirely. */
  warranty: string | null;
  /** The order page. Null when neither SHOP_PUBLIC_URL nor PUBLIC_URL is
   * configured — this template then renders no button at all rather than an
   * empty `href`, and the printed order code plus `/track` carry the reader. */
  orderUrl: string | null;
  /** The `/track` code-recovery page, null under the same condition as
   * `orderUrl`. */
  trackUrl: string | null;
}

/** Render each item as its own compact line, with an explicit line total so
 * the printed figure can never be misread as the line total when it is
 * actually the per-unit price (a customer reader, unlike `orderPaid.ts`'s
 * shop-owner reader, has no reason to know that convention):
 * "Netflix Premium (1 Month) — 2 × Rp50.000 = Rp100.000". */
function formatItemLine(item: OrderReadyItem): string {
  const variantPart = item.variant ? ` (${item.variant})` : "";
  return `${item.name}${variantPart} — ${item.quantity} × ${item.unitPrice} = ${item.lineTotal}`;
}

function buildItemsHtml(items: OrderReadyItem[]): string {
  const rows = items
    .map(
      (item) =>
        `<tr><td class="email-text" style="padding:6px 0;font-size:14px;color:${TEXT};">${escapeHtml(formatItemLine(item))}</td></tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin-bottom:8px;">${rows}</table>`;
}

function paragraph(text: string): string {
  return `<div class="email-text" style="font-size:15px;color:${TEXT};line-height:1.6;margin-bottom:16px;">${escapeHtml(text)}</div>`;
}

function mutedParagraph(text: string): string {
  return `<div class="email-muted" style="font-size:14px;color:${MUTED};line-height:1.6;margin-bottom:8px;">${escapeHtml(text)}</div>`;
}

/** The order code as its own prominent, copy-friendly block — not just an
 * `infoTable` row. It is the reader's credential, so it has to survive being
 * skim-read and be easy to select on a phone. */
function codeBlock(orderCode: string): string {
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:8px 0 24px 0;">` +
    `<tr><td align="center" style="background-color:#F4F4F5;border-radius:10px;padding:20px 16px;">` +
    `<div class="email-muted" style="font-size:12px;color:${MUTED};letter-spacing:0.08em;text-transform:uppercase;margin-bottom:8px;">Order Code / Kode Pesanan</div>` +
    `<div class="email-text" style="font-size:22px;font-weight:700;color:${TEXT};font-family:Menlo,Consolas,monospace;word-break:break-all;">${escapeHtml(orderCode)}</div>` +
    `</td></tr></table>`
  );
}

/** The `/track` fallback line: visible URL text, not just an href, so a
 * styling-stripped or text-only render still leaves it readable and
 * copy-pasteable — same reasoning as `fallbackLinkLine`. */
function trackLine(note: string, trackUrl: string): string {
  const escapedUrl = escapeHtml(trackUrl);
  return `<div class="email-muted" style="font-size:14px;color:${MUTED};line-height:1.6;margin-bottom:16px;word-break:break-all;">${escapeHtml(note)}<br /><a href="${escapedUrl}" style="color:#4F46E5;">${escapedUrl}</a></div>`;
}

export function renderOrderReadyEmail(input: OrderReadyInput, brand: BrandConfig): RenderedEmail {
  const summaryRows = [
    { label: LABEL_SUBTOTAL, value: input.subtotal },
    { label: LABEL_DISCOUNT, value: input.discount },
    // Between the discount and the total, which is where it is added: the
    // reader can run Subtotal - Discount + Unique code down the column and
    // land on the Total.
    { label: LABEL_UNIQUE_CODE, value: input.uniqueCode },
    { label: LABEL_TOTAL, value: input.total },
    // infoTable drops any row whose value is empty, so a null warranty needs
    // no branch here — but it does below in the plain-text build.
    { label: LABEL_WARRANTY, value: input.warranty ?? "" },
  ];

  // No `orderUrl` (neither SHOP_PUBLIC_URL nor PUBLIC_URL configured) renders
  // no button rather than one with an empty href — a dead button reads as a
  // broken email, while the code block and /track line below still work.
  const buttonHtml = input.orderUrl
    ? `<div style="margin-top:24px;margin-bottom:8px;">${primaryButton(BUTTON_LABEL, input.orderUrl, brand.accentColor)}${fallbackLinkLine(input.orderUrl)}</div>`
    : "";

  const trackHtml = input.trackUrl
    ? `${trackLine(EN_TRACK_NOTE, input.trackUrl)}${trackLine(ID_TRACK_NOTE, input.trackUrl)}`
    : "";

  const bodyHtml = `
    ${eventBanner("✅", BANNER_HEADING, EN_SUBHEADING, "success")}
    ${paragraph(EN_BODY)}
    ${paragraph(ID_HEADING + " — " + ID_BODY)}
    ${buildItemsHtml(input.items)}
    ${infoTable(summaryRows)}
    ${buttonHtml}
    ${mutedParagraph(EN_CODE_NOTE)}
    ${mutedParagraph(ID_CODE_NOTE)}
    ${codeBlock(input.orderCode)}
    ${trackHtml}
    ${divider()}
    ${footer(brand, { generatedByLine: "This is an automated notification — no reply needed." })}
  `;

  const html = renderShell({ brand, bodyHtml, preheader: PREHEADER });

  const itemLines = input.items.map((item) => ptKeyValue("Item", formatItemLine(item))).join("\n");
  const text = [
    ptSection(EN_HEADING),
    EN_SUBHEADING,
    "",
    EN_BODY,
    "",
    ptDivider(),
    ptSection("Order Summary"),
    itemLines,
    ptKeyValue(LABEL_SUBTOTAL, input.subtotal),
    ...(input.discount !== "" ? [ptKeyValue(LABEL_DISCOUNT, input.discount)] : []),
    ...(input.uniqueCode !== "" ? [ptKeyValue(LABEL_UNIQUE_CODE, input.uniqueCode)] : []),
    ptKeyValue(LABEL_TOTAL, input.total),
    ...(input.warranty ? [ptKeyValue(LABEL_WARRANTY, input.warranty)] : []),
    "",
    ptDivider(),
    ...(input.orderUrl ? ["", "Open your order:", input.orderUrl] : []),
    "",
    EN_CODE_NOTE,
    "",
    `Order code: ${input.orderCode}`,
    ...(input.trackUrl ? ["", EN_TRACK_NOTE, input.trackUrl] : []),
    "",
    ptDivider(),
    "",
    ptSection(ID_HEADING),
    ID_BODY,
    ...(input.orderUrl ? ["", "Buka pesanan kamu:", input.orderUrl] : []),
    "",
    ID_CODE_NOTE,
    "",
    `Kode pesanan: ${input.orderCode}`,
    ...(input.trackUrl ? ["", ID_TRACK_NOTE, input.trackUrl] : []),
    "",
    ptDivider(),
    "This is an automated notification — no reply needed.",
  ].join("\n");

  return { subject: SUBJECT, html, text };
}
