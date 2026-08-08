/**
 * Turns a path relative to this app's own origin (e.g. "web_logo_url"'s
 * stored value, "/uploads/branding/logo-abc123.png" — correct for a
 * browser resolving it against whatever page it's on) into an absolute
 * URL usable somewhere with no page context at all, like an email
 * client. Passes an already-absolute value through unchanged. Returns
 * null — no asset, not a guaranteed-broken relative URL — when there's
 * no path, or the path is relative but no usable `baseUrl` was given
 * (rendering it would just reproduce the exact bug this function exists
 * to prevent).
 *
 * `baseUrl` is caller-supplied rather than resolved here because the
 * "correct" base differs by recipient — the shop admin's origin for an
 * owner-facing email vs. the storefront's public origin for a
 * customer-facing one — and this function has no way to know which
 * email is calling it.
 */
export function toAbsoluteAssetUrl(path: string | null, baseUrl: string | null | undefined): string | null {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}
