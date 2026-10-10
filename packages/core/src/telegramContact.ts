/**
 * Turns the admin's free-text `support_contact` setting into a safe Telegram
 * link for the storefront's help/contact buttons. Pure; returns null for
 * anything that is not a recognizable Telegram handle or invite, so a typo or
 * a hostile value (`javascript:`, another domain) never becomes an href.
 */

// Telegram's username rule: 5-32 chars of [A-Za-z0-9_], starting with a letter
// and not ending with an underscore (the `[a-zA-Z][\w\d]{3,30}[a-zA-Z\d]`
// pattern from Telegram's own username validation).
const HANDLE_RE = /^[A-Za-z][A-Za-z0-9_]{3,30}[A-Za-z0-9]$/;
// Private-chat invite hashes: `t.me/+<hash>` and the older `t.me/joinchat/<hash>`.
const INVITE_HASH_RE = /^[A-Za-z0-9_-]{8,}$/;
// Optional scheme, optional www., t.me / telegram.me host, then a path.
const LINK_RE = /^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/(.+)$/i;

export function telegramContactUrl(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;

  const link = LINK_RE.exec(text);
  if (link) {
    // Drop a query string / fragment and one trailing slash; nothing else.
    const path = link[1]!.split(/[?#]/)[0]!.replace(/\/$/, "");
    if (path.startsWith("+")) {
      return INVITE_HASH_RE.test(path.slice(1)) ? `https://t.me/${path}` : null;
    }
    if (path.startsWith("joinchat/")) {
      return INVITE_HASH_RE.test(path.slice("joinchat/".length)) ? `https://t.me/${path}` : null;
    }
    if (path.toLowerCase() === "joinchat") return null; // invite prefix with no hash
    return HANDLE_RE.test(path) ? `https://t.me/${path}` : null;
  }

  const handle = text.startsWith("@") ? text.slice(1) : text;
  return HANDLE_RE.test(handle) ? `https://t.me/${handle}` : null;
}
