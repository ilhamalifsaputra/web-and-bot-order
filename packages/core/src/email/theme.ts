/**
 * Light/dark color tokens for the email design system. Email clients can't
 * run real CSS custom properties or a JS theme switcher, so "theming" here
 * means two fixed palettes: light-mode values get inlined directly onto
 * elements (inline styles can't respond to a media query), and dark-mode
 * overrides live in the one `<style>` block layout.ts embeds, targeting the
 * classes/ids that block assigns.
 */
import { escapeHtml } from "./escape";
import type { BrandConfig } from "./types";

export interface ColorTokens {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
}

/** Light-mode tokens — the ones inlined directly onto elements. Only the
 * accent color is brand-configurable; the neutrals are fixed so every shop's
 * email reads as the same well-tested design regardless of accent choice. */
export function resolveTokens(brand: BrandConfig): ColorTokens {
  return {
    bg: "#F4F4F5",
    surface: "#FFFFFF",
    text: "#18181B",
    muted: "#71717A",
    border: "#E4E4E7",
    accent: brand.accentColor,
  };
}

/** Dark-mode equivalents of the fixed neutrals above. The accent color is
 * reused as-is in dark mode (kept legible against a dark surface — shops
 * pick a mid-tone brand color, not a near-white one, so this is a reasonable
 * default without per-shop dark-accent configuration). */
const DARK = {
  bg: "#18181B",
  surface: "#27272A",
  text: "#FAFAFA",
  muted: "#A1A1AA",
  border: "#3F3F46",
};

/**
 * The classes/ids referenced here (`email-bg`, `email-surface`, `email-text`,
 * `email-muted`, `email-border`, `email-button-bg`) must be assigned by
 * layout.ts/components.ts on the elements whose color should flip (or, for
 * the accent, stay pinned) in dark mode — this file only produces the CSS
 * text, it doesn't touch markup.
 *
 * `.email-button-bg` (primaryButton's bulletproof-button cell in
 * components.ts) re-asserts the same accent value under `prefers-color-scheme:
 * dark` rather than swapping to a different color — the accent is kept
 * legible on both light and dark surfaces (see DARK's comment above), but
 * some clients apply their own heuristic dark-mode color inversion to
 * inline styles unless an explicit dark rule pins the value, so this
 * `!important` override exists to stop that from happening to the button.
 * There used to be an `.email-accent-text` rule here too, but no element in
 * layout.ts/components.ts ever carried that class (accent color is never
 * used for text in this design system) — removed as dead CSS rather than
 * inventing a use for it.
 */
export function buildThemeStyleBlock(brand: BrandConfig): string {
  const tokens = resolveTokens(brand);
  // Not validated here (only at the Settings-save boundary, Task 5) — escape
  // like every other BrandConfig field that reaches markup, since this value
  // is interpolated directly into a `<style>` block.
  const accent = escapeHtml(tokens.accent);
  return `
    @media (prefers-color-scheme: dark) {
      .email-bg { background-color: ${DARK.bg} !important; }
      .email-surface { background-color: ${DARK.surface} !important; }
      .email-text { color: ${DARK.text} !important; }
      .email-muted { color: ${DARK.muted} !important; }
      .email-border { border-color: ${DARK.border} !important; }
      .email-button-bg { background-color: ${accent} !important; }
    }
  `;
}
