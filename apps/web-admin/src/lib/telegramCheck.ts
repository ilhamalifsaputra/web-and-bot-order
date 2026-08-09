/**
 * Injectable Telegram token check, shared by routes/settings.ts (§16.4 bot-token
 * edits) and routes/setup.ts (first-run wizard step 1). A single module-level
 * validator is swapped out in tests via setTokenValidator so they never hit the
 * network; the token never appears in logs or error messages.
 */
export type TokenCheck = { ok: boolean; username?: string };

// Bounds how long a hung api.telegram.org call can hold this single-process
// app's request thread (Admin-3 fix, security audit 2026-06-23).
const TELEGRAM_FETCH_TIMEOUT_MS = 5000;

/**
 * Ask Telegram whether the token works. Plain fetch (no grammy dependency
 * here); the token never appears in logs or error messages.
 */
export async function checkTokenWithTelegram(token: string): Promise<TokenCheck> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TELEGRAM_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: ac.signal });
    const data = (await res.json()) as { ok?: boolean; result?: { username?: string } };
    return data.ok ? { ok: true, username: data.result?.username } : { ok: false };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
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

export type ChannelCheck = {
  ok: boolean;
  id?: number;
  title?: string;
  type?: string; // "channel" | "group" | "supergroup" | "private" — from getChat
  username?: string; // public @username, if any
  inviteLink?: string; // getChat's invite_link — only populated when the bot is admin of that chat
};

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
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TELEGRAM_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/getChat?chat_id=${encodeURIComponent(chat)}`,
      { signal: ac.signal },
    );
    const data = (await res.json()) as {
      ok?: boolean;
      result?: { id?: number; title?: string; type?: string; username?: string; invite_link?: string };
    };
    return data.ok && typeof data.result?.id === "number"
      ? {
          ok: true,
          id: data.result.id,
          title: data.result.title,
          type: data.result.type,
          username: data.result.username,
          inviteLink: data.result.invite_link,
        }
      : { ok: false };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
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

export type BotAdminCheck = { ok: boolean; isAdmin: boolean };

/**
 * Confirm the bot itself is an admin of chatId — getChatMember is only reliable
 * for an arbitrary user when the bot is an admin of that chat. Checked at save
 * time rather than discovered later as a silent fail-open on every update.
 * Two-step plain fetch (same pattern as the rest of this file): getMe to get the
 * bot's own numeric id, then getChatMember with that id. Status "administrator"
 * or "creator" -> isAdmin: true; anything else -> false. A failed request or
 * exception -> { ok: false, isAdmin: false }.
 */
export async function checkBotIsAdminOf(botToken: string, chatId: number): Promise<BotAdminCheck> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TELEGRAM_FETCH_TIMEOUT_MS);
  try {
    const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, { signal: ac.signal });
    const meData = (await meRes.json()) as { ok?: boolean; result?: { id?: number } };
    if (!meData.ok || typeof meData.result?.id !== "number") return { ok: false, isAdmin: false };

    const memberRes = await fetch(
      `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(String(chatId))}&user_id=${meData.result.id}`,
      { signal: ac.signal },
    );
    const memberData = (await memberRes.json()) as { ok?: boolean; result?: { status?: string } };
    if (!memberData.ok) return { ok: false, isAdmin: false };
    const status = memberData.result?.status;
    return { ok: true, isAdmin: status === "administrator" || status === "creator" };
  } catch {
    return { ok: false, isAdmin: false };
  } finally {
    clearTimeout(timer);
  }
}

let botAdminValidator: (botToken: string, chatId: number) => Promise<BotAdminCheck> = checkBotIsAdminOf;

/** Test hook: stub the getChatMember check so tests never hit the network. */
export function setBotAdminValidator(fn: typeof botAdminValidator): void {
  botAdminValidator = fn;
}

/** Current bot-admin validator (the stub in tests, the real check otherwise). */
export function getBotAdminValidator(): typeof botAdminValidator {
  return botAdminValidator;
}

export type JoinUrlResolution = { ok: true; url: string } | { ok: false };

/**
 * Resolve a URL the user can tap to join, from a ChannelCheck result. Priority:
 * check.username (-> `https://t.me/${username}`) > check.inviteLink (from
 * getChat) > mint a fresh one via exportChatInviteLink(chatId) (for private
 * chats where the bot is admin but getChat hasn't returned an invite_link yet).
 * If all three sources fail -> { ok: false }.
 */
export async function resolveJoinUrl(botToken: string, check: ChannelCheck): Promise<JoinUrlResolution> {
  if (check.username) return { ok: true, url: `https://t.me/${check.username}` };
  if (check.inviteLink) return { ok: true, url: check.inviteLink };
  if (typeof check.id !== "number") return { ok: false };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TELEGRAM_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/exportChatInviteLink?chat_id=${encodeURIComponent(String(check.id))}`,
      { signal: ac.signal },
    );
    const data = (await res.json()) as { ok?: boolean; result?: string };
    return data.ok && typeof data.result === "string" ? { ok: true, url: data.result } : { ok: false };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

let joinUrlResolver: (botToken: string, check: ChannelCheck) => Promise<JoinUrlResolution> = resolveJoinUrl;

/** Test hook: stub the join-URL resolution so tests never hit the network. */
export function setJoinUrlResolver(fn: typeof joinUrlResolver): void {
  joinUrlResolver = fn;
}

/** Current join-URL resolver (the stub in tests, the real resolution otherwise). */
export function getJoinUrlResolver(): typeof joinUrlResolver {
  return joinUrlResolver;
}

/** True when check.type is one of wantTypes. */
export function matchesExpectedType(check: ChannelCheck, wantTypes: string[]): boolean {
  return typeof check.type === "string" && wantTypes.includes(check.type);
}

export type FileResolution = { ok: true; filePath: string } | { ok: false };

/**
 * Resolve a Telegram `file_id` to its `file_path` via getFile — used by the
 * admin support-ticket photo-preview route. Plain fetch (no grammy here); the
 * bot token never appears in logs or error messages.
 */
export async function resolveTelegramFile(botToken: string, fileId: string): Promise<FileResolution> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TELEGRAM_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`,
      { signal: ac.signal },
    );
    const data = (await res.json()) as { ok?: boolean; result?: { file_path?: string } };
    return data.ok && typeof data.result?.file_path === "string"
      ? { ok: true, filePath: data.result.file_path }
      : { ok: false };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

let fileResolver: (botToken: string, fileId: string) => Promise<FileResolution> = resolveTelegramFile;

/** Test hook: stub the getFile call so tests never hit the network. */
export function setFileResolver(fn: typeof fileResolver): void {
  fileResolver = fn;
}

/** Current file resolver (the stub in tests, the real getFile otherwise). */
export function getFileResolver(): typeof fileResolver {
  return fileResolver;
}
