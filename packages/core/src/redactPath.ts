/**
 * One shared list of URL path segments whose NEXT segment is a secret, and
 * the scrubber both web apps run over a request path before it reaches a log
 * line (CLAUDE.md: "Never log secrets").
 *
 *  - `reset` — the storefront's single-use password-reset token
 *    (`/reset/:token`, `/api/v1/auth/reset/:token`).
 *  - `tg` — the Telegram webhook route `/tg/<WEBHOOK_SECRET>` that
 *    apps/server mounts on the web-admin app in webhook mode. Anyone holding
 *    that path segment can POST updates straight at the bot (backend audit
 *    Task C2: it used to be written in full into every access-log line).
 *
 * Add a segment here, not a new regex in one app, when a new route carries a
 * secret in its path. The match is a whole segment (`/tg/` but not `/tgx/`)
 * anywhere in the path, so the same rule covers API-prefixed variants.
 */
export const SECRET_PATH_SEGMENTS: readonly string[] = ["reset", "tg"];

const SECRET_SEGMENT_RE = new RegExp(`/(${SECRET_PATH_SEGMENTS.join("|")})/[^/]+`, "g");

/** `path` with the segment following each secret-bearing segment replaced by `[redacted]`. */
export function redactSecretPath(path: string): string {
  return path.replace(SECRET_SEGMENT_RE, "/$1/[redacted]");
}
