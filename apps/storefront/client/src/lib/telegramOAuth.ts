/** Builds the oauth.telegram.org direct-link login URL (no JS widget/iframe
 *  needed — see https://core.telegram.org/widgets/login, "Redirect" option).
 *  Telegram 303s the whole browser back to `returnTo` with the same signed
 *  query params the widget script used to produce, landing on the existing
 *  /auth/telegram or /account/settings/link-telegram routes unchanged. */
export function buildTelegramOAuthUrl(
  botId: string,
  authUrl: string,
  origin: string = window.location.origin,
): string {
  const params = new URLSearchParams({
    bot_id: botId,
    origin,
    return_to: origin + authUrl,
    request_access: "write",
    embed: "0",
  });
  return `https://oauth.telegram.org/auth?${params.toString()}`;
}
