/**
 * The storefront customer "reset your password" email
 * (apps/storefront/src/routes/apiAuth.ts's `/auth/forgot`) — a visual
 * upgrade of the plain-text email that route currently sends inline.
 * ADMIN_PW_RESET (the admin panel's own Telegram-DM reset) is a different
 * flow entirely and untouched by this template (Global Constraints scope
 * decision 3).
 *
 * The `html` output is English-only — this is a visual upgrade of an
 * existing bilingual plain-text email, not a new i18n requirement. The
 * `text` output is what preserves the bilingual guarantee (English
 * paragraph then Indonesian paragraph, matching apiAuth.ts's existing
 * phrasing) for clients that render text-only.
 */
import { renderShell } from "../layout";
import {
  title,
  subtitle,
  primaryButton,
  fallbackLinkLine,
  infoTable,
  alertBox,
  footer,
  TEXT,
  MUTED,
} from "../components";
import { ptSection, ptDivider } from "../plaintext";
import { escapeHtml } from "../escape";
import { buildSubject } from "../subject";
import type { BrandConfig, EmailCopy, RenderedEmail } from "../types";

export interface ResetPasswordInput {
  resetUrl: string;
  expiryMinutes: number;
  /** Formatted "YYYY-MM-DD HH:mm UTC" or similar — rendered verbatim. */
  requestedAt: string;
  ip: string | null;
  /** Raw header value, shown verbatim (escaped) as "Device" — no UA-parsing
   * library (Global Constraints scope decision 2: no new dependency). */
  userAgent: string | null;
}

export function renderResetPasswordEmail(
  input: ResetPasswordInput,
  brand: BrandConfig,
  copy: EmailCopy,
): RenderedEmail {
  const expiryLine = `This link expires in ${input.expiryMinutes} minutes.`;

  const securityRows = [
    { label: "Request Time", value: input.requestedAt },
    { label: "IP", value: input.ip ?? "" },
    { label: "Device", value: input.userAgent ?? "" },
  ];

  const bodyHtml = `
    ${title(copy.title)}
    ${subtitle(copy.subtitle)}
    <div class="email-text" style="font-size:15px;color:${TEXT};line-height:1.6;margin-bottom:24px;">${escapeHtml(copy.message)}</div>
    <div style="margin-bottom:16px;">${primaryButton("Reset Password", input.resetUrl, brand.accentColor)}</div>
    <div class="email-muted" style="font-size:14px;color:${MUTED};margin-bottom:24px;">${escapeHtml(expiryLine)}</div>
    ${infoTable(securityRows)}
    <div style="margin-top:24px;">${alertBox(
      "Didn't request this?",
      "You can safely ignore this email — your password will not change unless you click the link above and choose a new one. If this keeps happening, please contact support.",
      "warning",
    )}</div>
    ${fallbackLinkLine(input.resetUrl)}
    ${footer(brand, { generatedByLine: "This is an automated notification — no reply needed." })}
  `;

  const html = renderShell({
    brand,
    bodyHtml,
    preheader: "Reset your password",
  });

  const text = [
    ptSection(copy.title),
    `Click to set a new password (valid ${input.expiryMinutes} minutes):`,
    input.resetUrl,
    "",
    "If you didn't request this, ignore this email — your password is unchanged.",
    "",
    ptDivider(),
    "",
    `Klik untuk membuat kata sandi baru (berlaku ${input.expiryMinutes} menit):`,
    input.resetUrl,
    "",
    "Abaikan email ini jika kamu tidak memintanya — kata sandimu tidak berubah.",
  ].join("\n");

  return { subject: buildSubject(copy, brand), html, text };
}
