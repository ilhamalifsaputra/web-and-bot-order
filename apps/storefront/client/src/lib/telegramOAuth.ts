/** Legacy Telegram direct authorization. Return paths accept a fragment bridge as well as signed query callbacks. */
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
