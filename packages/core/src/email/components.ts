/**
 * Reusable inline-styled building blocks composed by the template functions.
 * Each function returns a self-contained HTML fragment (table rows/cells,
 * never bare `<div>`s that assume a flex/grid parent) and escapes its own
 * text inputs internally — callers always pass raw, unescaped strings in.
 */
import { escapeHtml } from "./escape";
import { resolveAccentColor } from "./theme";
import type { BrandConfig } from "./types";

// Fixed neutrals shared with theme.ts's light-mode tokens — components that
// don't take a BrandConfig (and so can't call resolveTokens) still need the
// same text/muted/border colors to look consistent with the shell. Exported
// so the template files (templates/orderPaid.ts, templates/resetPassword.ts)
// can reuse the same constants instead of re-hardcoding the hex values.
export const TEXT = "#18181B";
export const MUTED = "#71717A";
export const BORDER = "#E4E4E7";

export function title(text: string): string {
  return `<div class="email-text" style="font-size:28px;line-height:1.3;font-weight:700;color:${TEXT};margin:0 0 8px 0;">${escapeHtml(text)}</div>`;
}

export function subtitle(text: string): string {
  return `<div class="email-muted" style="font-size:18px;line-height:1.4;font-weight:400;color:${MUTED};margin:0 0 24px 0;">${escapeHtml(text)}</div>`;
}

/** A 1px border-color rule row — a `<table>` row rather than an `<hr>` so it
 * behaves consistently inside the table-based layout (Outlook renders `<hr>`
 * inconsistently). */
export function divider(): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;"><tr><td class="email-border" style="border-top:1px solid ${BORDER};font-size:0;line-height:0;" height="1">&nbsp;</td></tr></table>`;
}

export type StatusTone = "success" | "warning" | "danger" | "neutral";

const TONE_COLORS: Record<StatusTone, { bg: string; fg: string }> = {
  success: { bg: "#DCFCE7", fg: "#16A34A" },
  warning: { bg: "#FEF3C7", fg: "#F59E0B" },
  danger: { bg: "#FEE2E2", fg: "#DC2626" },
  neutral: { bg: "#F4F4F5", fg: "#71717A" },
};

export function statusBadge(text: string, tone: StatusTone): string {
  const { bg, fg } = TONE_COLORS[tone];
  return `<span style="display:inline-block;padding:4px 12px;border-radius:999px;background-color:${bg};color:${fg};font-size:13px;font-weight:700;letter-spacing:0.02em;">${escapeHtml(text)}</span>`;
}

export interface InfoRow {
  label: string;
  value: string;
}

/** Label/value pairs as table rows, used for both the order summary and the
 * reset-password security card. A row is skipped entirely (not rendered
 * with an empty value) when `value` is empty/null — callers should not pass
 * placeholder rows for absent data. */
export function infoTable(rows: InfoRow[]): string {
  const rowsHtml = rows
    .filter((r) => r.value != null && r.value !== "")
    .map(
      (r) =>
        `<tr><td class="email-muted" style="padding:8px 0;color:${MUTED};font-size:14px;vertical-align:top;width:40%;" width="40%">${escapeHtml(r.label)}</td><td class="email-text" style="padding:8px 0;color:${TEXT};font-size:14px;font-weight:600;text-align:right;vertical-align:top;" align="right">${escapeHtml(r.value)}</td></tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">${rowsHtml}</table>`;
}

/**
 * Bulletproof-button pattern: a colored table cell with padding, not a raw
 * `<a>` styled as a block — some email clients (notably Outlook desktop's
 * Word rendering engine) strip padding/border-radius/background from a
 * styled `<a>` but respect them on a `<td>`. The `<a>` inside just carries
 * the href and inherits the cell's look via its own inline styles.
 *
 * `accentColor` is the shop's `BrandConfig.accentColor` — the CTA button is
 * the most prominent branded element in a transactional email, so its
 * background reflects the shop's configured accent (unlike `statusBadge`,
 * which deliberately stays on fixed semantic tone colors regardless of
 * branding). `class="email-button-bg"` pins this color under
 * `prefers-color-scheme: dark` too — see theme.ts's buildThemeStyleBlock.
 *
 * `accentColor` is validated via theme.ts's `resolveAccentColor` before use
 * — an empty or malformed value (e.g. Settings' `email_brand_color` cleared
 * to `""`) falls back to the coded default rather than rendering an
 * invisible white-on-transparent button (`background-color:;`).
 */
export function primaryButton(text: string, href: string, accentColor: string): string {
  const escapedText = escapeHtml(text);
  const escapedHref = escapeHtml(href);
  const escapedAccent = escapeHtml(resolveAccentColor(accentColor));
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="border-radius:10px;background-color:${escapedAccent};" class="email-button-bg"><a href="${escapedHref}" aria-label="${escapedText}" style="display:inline-block;padding:12px 28px;font-size:16px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:10px;">${escapedText}</a></td></tr></table>`;
}

/** "If the button doesn't work..." fallback for clients that block button
 * styling or images — shows the visible URL text, not just an href, so a
 * text-only or styling-stripped render still leaves the link readable and
 * copy-pasteable. */
export function fallbackLinkLine(href: string): string {
  const escapedHref = escapeHtml(href);
  return `<div class="email-muted" style="font-size:13px;color:${MUTED};margin-top:16px;word-break:break-all;">If the button doesn't work, copy and paste this URL into your browser:<br /><a href="${escapedHref}" style="color:#4F46E5;">${escapedHref}</a></div>`;
}

export type AlertTone = "warning" | "info";

export function alertBox(heading: string, message: string, tone: AlertTone): string {
  const bg = tone === "warning" ? "#FEF3C7" : "#F4F4F5";
  const border = tone === "warning" ? "#F59E0B" : BORDER;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:${bg};border:1px solid ${border};border-radius:8px;margin:24px 0;"><tr><td style="padding:16px;"><div style="font-size:14px;font-weight:700;color:${TEXT};margin-bottom:4px;">${escapeHtml(heading)}</div><div style="font-size:14px;color:${TEXT};line-height:1.5;">${escapeHtml(message)}</div></td></tr></table>`;
}

export interface FooterArgs {
  generatedByLine: string;
}

/** The generated-by line, then a support line and a store-link line — each
 * omitted entirely (not rendered blank) when the corresponding BrandConfig
 * field is null. The two optional lines are independent: either, both, or
 * neither may render. */
export function footer(brand: BrandConfig, args: FooterArgs): string {
  const supportLine = brand.supportEmail
    ? `<div style="margin-top:4px;">Need help? ${escapeHtml(brand.supportEmail)}</div>`
    : "";
  const storeLine = brand.storeUrl
    ? `<div style="margin-top:4px;">${escapeHtml(brand.storeUrl)}</div>`
    : "";
  return `<div class="email-muted" style="font-size:12px;color:${MUTED};text-align:center;margin-top:32px;line-height:1.6;">${escapeHtml(args.generatedByLine)}${supportLine}${storeLine}</div>`;
}
