/** Read fresh on every call (not cached at module-load time) — this is what
 * makes the CSRF token testable independent of when this module happens to
 * be imported relative to the meta tag existing in the DOM. */
function csrfToken(): string {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") ?? "";
}

/**
 * POST without a CSRF token — for unauthenticated setup wizard endpoints
 * (no admin session exists yet; the setup routes explicitly carry no CSRF).
 */
export async function publicPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error ?? `${path} failed ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** The literal 403 body both `csrfCheck` (plugins/auth.ts) and the multipart
 * `handleUpload()` (lib/upload.ts) send when the token doesn't match the
 * current session — happens when this tab's `<meta name="csrf-token">` was
 * baked in under an older session that a newer login (another tab/device)
 * has since silently replaced (every `POST /login` rotates the one stored
 * session token per admin, invalidating any other open session for them).
 * The fix is a full reload to pick up the current session's token, so we
 * surface that instead of the bare, unexplained server string. */
const CSRF_FAILURE_BODY = "CSRF check failed";
const STALE_SESSION_MESSAGE = "Your session was refreshed in another tab. Reload this page to continue.";

/** Shared failure path for every helper below: read the body as text first
 * (a CSRF failure is `text/plain`, not JSON — calling `.json()` on it would
 * throw), special-case the stale-session CSRF failure, then fall back to a
 * `{ error }` JSON body's message or a generic "<path> responded <status>". */
async function throwForResponse(res: Response, path: string): Promise<never> {
  const text = await res.text().catch(() => "");
  if (res.status === 403 && text.trim() === CSRF_FAILURE_BODY) {
    throw new Error(STALE_SESSION_MESSAGE);
  }
  let data: { error?: string } = {};
  try {
    data = text ? (JSON.parse(text) as { error?: string }) : {};
  } catch {
    // Not JSON — fall through to the generic message below.
  }
  throw new Error(data.error ?? `${path} responded ${res.status}`);
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "include" });
  if (!res.ok) return throwForResponse(res, path);
  return res.json() as Promise<T>;
}

/** No caller yet in this plan — foundational plumbing for the first future
 * mutating dashboard action. Attaches the page's CSRF token as a header
 * (see apps/web-admin/src/plugins/auth.ts's csrfCheck, which accepts this
 * header as an alternative to the form-field token HTML forms use). */
export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken() },
    body: JSON.stringify(body),
  });
  if (!res.ok) return throwForResponse(res, path);
  return res.json() as Promise<T>;
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken() },
    body: JSON.stringify(body),
  });
  if (!res.ok) return throwForResponse(res, path);
  return res.json() as Promise<T>;
}

export async function apiDelete<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    method: "DELETE",
    credentials: "include",
    headers: { "X-CSRF-Token": csrfToken() },
  });
  if (!res.ok) return throwForResponse(res, path);
  return res.json() as Promise<T>;
}

/**
 * Ends the admin session. `POST /logout` (apps/web-admin/src/routes/auth.ts)
 * uses `optionalAdmin`, not the `currentAdmin` + `csrfProtect` preHandler
 * chain, so it doesn't check a CSRF token — a plain fetch is enough. The
 * route clears the session cookie server-side and 303-redirects to /login;
 * callers should navigate to /login themselves once this resolves (fetch
 * follows the redirect internally, so `res.ok` reflects the final response).
 */
export async function logout(): Promise<void> {
  const res = await fetch("/logout", { method: "POST", credentials: "include" });
  if (!res.ok) {
    throw new Error(`Logout failed (${res.status})`);
  }
}
