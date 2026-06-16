/**
 * Injectable Telegram token check, shared by routes/settings.ts (§16.4 bot-token
 * edits) and routes/setup.ts (first-run wizard step 1). A single module-level
 * validator is swapped out in tests via setTokenValidator so they never hit the
 * network; the token never appears in logs or error messages.
 */
export type TokenCheck = { ok: boolean; username?: string };

/**
 * Ask Telegram whether the token works. Plain fetch (no grammy dependency
 * here); the token never appears in logs or error messages.
 */
export async function checkTokenWithTelegram(token: string): Promise<TokenCheck> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await res.json()) as { ok?: boolean; result?: { username?: string } };
    return data.ok ? { ok: true, username: data.result?.username } : { ok: false };
  } catch {
    return { ok: false };
  }
}

let tokenValidator: (token: string) => Promise<TokenCheck> = checkTokenWithTelegram;

/** Test hook: stub the Telegram call so tests never hit the network. */
export function setTokenValidator(fn: typeof tokenValidator): void {
  tokenValidator = fn;
}

/** Current validator (the stub in tests, the real getMe call otherwise). */
export function getTokenValidator(): typeof tokenValidator {
  return tokenValidator;
}

export type ChannelCheck = { ok: boolean; id?: number; title?: string };

/**
 * Normalize admin input to a Telegram `chat_id` argument:
 * link / @username / bare username -> "@username"; a numeric (-100…) id is
 * passed through unchanged.
 */
export function normalizeChannelInput(input: string): string {
  let s = input.trim();
  if (/^-?\d+$/.test(s)) return s; // numeric id (e.g. -1003960444894)
  s = s.replace(/^https?:\/\//i, "").replace(/^t\.me\//i, "").replace(/^@/, "");
  return `@${s}`;
}

/**
 * Resolve a channel input to its numeric id via getChat. Plain fetch (no grammy
 * here); the bot token never appears in logs or error messages.
 */
export async function checkChannelWithTelegram(botToken: string, input: string): Promise<ChannelCheck> {
  const chat = normalizeChannelInput(input);
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/getChat?chat_id=${encodeURIComponent(chat)}`,
    );
    const data = (await res.json()) as { ok?: boolean; result?: { id?: number; title?: string } };
    return data.ok && typeof data.result?.id === "number"
      ? { ok: true, id: data.result.id, title: data.result.title }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

let channelValidator: (botToken: string, input: string) => Promise<ChannelCheck> = checkChannelWithTelegram;

/** Test hook: stub the getChat call so tests never hit the network. */
export function setChannelValidator(fn: typeof channelValidator): void {
  channelValidator = fn;
}

/** Current channel validator (the stub in tests, the real getChat otherwise). */
export function getChannelValidator(): typeof channelValidator {
  return channelValidator;
}
