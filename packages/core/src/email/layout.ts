/**
 * The outer HTML document shell every template renders its body into.
 * Table-based (email clients — especially Outlook's Word rendering engine —
 * ignore/strip a lot of modern block CSS, but a `<table role="presentation">`
 * lays out reliably everywhere), inline styles + matching `width` attributes
 * (Outlook needs both, since it partially ignores CSS width), max 600px
 * container. The only `<style>` block in the whole document is the
 * `prefers-color-scheme: dark` media query from theme.ts.
 */
import { buildThemeStyleBlock, resolveTokens } from "./theme";
import { escapeHtml } from "./escape";
import type { BrandConfig } from "./types";

export interface RenderShellArgs {
  brand: BrandConfig;
  bodyHtml: string;
  preheader?: string;
}

/** A 3px accent rule under the header, matching the "header rule" use case
 * named alongside buttons/badges in the Settings description. `accent` is
 * `brand.accentColor` and must be escaped like every other BrandConfig
 * field that reaches markup — it is not validated here, only at the
 * Settings-save boundary (Task 5), so a malicious value must still be
 * neutralized at the point it's interpolated into a `style` attribute. */
function accentRuleHtml(accent: string): string {
  return `<tr><td style="padding:16px 32px 0 32px;"><div style="height:3px;background-color:${escapeHtml(accent)};border-radius:2px;"></div></td></tr>`;
}

export function renderShell(args: RenderShellArgs): string {
  const { brand, bodyHtml, preheader } = args;
  const tokens = resolveTokens(brand);
  const styleBlock = buildThemeStyleBlock(brand);

  // Preheader: the short preview text some clients (Gmail, Apple Mail) show
  // next to the subject line in the inbox list. Hidden via near-zero size +
  // clipped overflow rather than display:none, which some clients ignore.
  const preheaderHtml = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;">${escapeHtml(preheader)}</div>`
    : "";

  // Logo <img> is omitted entirely (not rendered with an empty src) when
  // logoUrl is falsy — an empty src re-requests the current page in some
  // clients, and a broken-image icon is worse than no logo at all.
  const logoHtml = brand.logoUrl
    ? `<img src="${escapeHtml(brand.logoUrl)}" alt="${escapeHtml(brand.shopName)}" width="140" style="display:block;border:0;outline:none;text-decoration:none;max-width:140px;height:auto;" />`
    : "";

  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<title>${escapeHtml(brand.shopName)}</title>
<style>${styleBlock}</style>
</head>
<body class="email-bg" style="margin:0;padding:0;background-color:${tokens.bg};">
${preheaderHtml}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:${tokens.bg};">
<tr>
<td align="center" style="padding:24px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="email-surface" style="width:100%;max-width:600px;background-color:${tokens.surface};border-radius:12px;overflow:hidden;">
<tr>
<td style="padding:32px 32px 16px 32px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td align="left" style="vertical-align:middle;">
${logoHtml}
<div class="email-text" style="font-size:16px;font-weight:700;color:${tokens.text};margin-top:${brand.logoUrl ? "8px" : "0"};">${escapeHtml(brand.shopName)}</div>
</td>
</tr>
</table>
</td>
</tr>
${accentRuleHtml(tokens.accent)}
<tr>
<td style="padding:24px 32px 32px 32px;">
${bodyHtml}
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`;
}
