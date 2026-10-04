/**
 * One-time "link Telegram" intents — backend audit Task C fix round.
 *
 * `GET /account/settings/link-telegram` is where oauth.telegram.org sends the
 * browser back, so it must be a cookie-authenticated GET and cannot carry a
 * CSRF header. Without more, any site could navigate a signed-in victim's
 * browser to that URL with the ATTACKER's own (validly signed) widget params:
 * the attacker's Telegram would be linked to the victim's account and the
 * attacker could then sign in as the victim through /auth/telegram.
 *
 * So the settings page first arms a link with a CSRF-checked
 * `POST /api/v1/account/settings/link-telegram/start`, and the GET only links
 * if that account has an unexpired, unused intent, which it consumes. A
 * cross-site navigation can't create an intent, so it lands on ?err=tg_invalid.
 *
 * In-process Map, like every throttle in rateLimit.ts (the storefront runs as
 * one process). A restart drops pending intents; the buyer just clicks again.
 */

export const TELEGRAM_LINK_INTENT_TTL_MS = 10 * 60_000;

const intents = new Map<number, number>(); // userId -> expiry (ms epoch)

function prune(now: number): void {
  for (const [userId, expiresAt] of intents) {
    if (expiresAt <= now) intents.delete(userId);
  }
}

/** Arm one Telegram link for `userId`, valid for TELEGRAM_LINK_INTENT_TTL_MS. */
export function startTelegramLinkIntent(userId: number): void {
  const now = Date.now();
  prune(now);
  intents.set(userId, now + TELEGRAM_LINK_INTENT_TTL_MS);
}

/** True (and the intent is used up) if `userId` has an unexpired intent. */
export function consumeTelegramLinkIntent(userId: number): boolean {
  const expiresAt = intents.get(userId);
  intents.delete(userId);
  return expiresAt !== undefined && expiresAt > Date.now();
}
