/**
 * Shared TS interfaces for the HTML email design system. Pure types only —
 * no runtime code here.
 */

/** Per-shop branding, resolved by the caller from Settings before rendering
 * (this folder never reads Settings/DB itself). */
export interface BrandConfig {
  shopName: string;
  logoUrl: string | null;
  accentColor: string;
  supportEmail: string | null;
  storeUrl: string | null;
}

/** The resolved, already-defaulted copy for one template — the caller has
 * already applied the Settings override-or-default logic before this point. */
export interface EmailCopy {
  subject: string;
  title: string;
  subtitle: string;
  message: string;
}

/** The return shape every template function produces. `text` is required
 * (not optional) because `sendMail` requires it and some clients render
 * text-only. */
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}
