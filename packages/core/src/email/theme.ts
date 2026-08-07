/**
 * Light/dark color tokens for the email design system. Email clients can't
 * run real CSS custom properties or a JS theme switcher, so "theming" here
 * means two fixed palettes: light-mode values get inlined directly onto
 * elements (inline styles can't respond to a media query), and dark-mode
 * overrides live in the one `<style>` block layout.ts embeds, targeting the
 * classes/ids that block assigns.
 */
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
 * `email-muted`, `email-border`, `email-accent-text`) must be assigned by
 * layout.ts/components.ts on the elements whose color should flip in dark
 * mode — this file only produces the CSS text, it doesn't touch markup.
 */
export function buildThemeStyleBlock(brand: BrandConfig): string {
  const tokens = resolveTokens(brand);
  return `
    @media (prefers-color-scheme: dark) {
      .email-bg { background-color: ${DARK.bg} !important; }
      .email-surface { background-color: ${DARK.surface} !important; }
      .email-text { color: ${DARK.text} !important; }
      .email-muted { color: ${DARK.muted} !important; }
      .email-border { border-color: ${DARK.border} !important; }
      .email-accent-text { color: ${tokens.accent} !important; }
    }
  `;
}
