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
