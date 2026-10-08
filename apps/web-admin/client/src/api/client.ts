/** Read fresh on every call (not cached at module-load time) — this is what
 * makes the CSRF token testable independent of when this module happens to
 * be imported relative to the meta tag existing in the DOM. */
function csrfToken(): string {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") ?? "";
}

/**
 * An API failure, as every helper in this file throws it.
 *
 * `message` stays exactly what it always was — the server's i18n key when it sent
 * one, a developer-facing "<path> responded <status>" otherwise — because pages
 * compare it (`=== "error.order_not_processing"`) and `describeError` looks it up.
 */
export interface ApiError extends Error {
  /**
   * The figures the message's `{placeholder}`s name, from the response's
   * `error_args` (whole-branch review F4a; P2 on this surface).
   *
   * Much of this shop's refusal copy quotes a number or a name — "{product} has
   * no stock reserved", "{refundable} {currency} is still refundable", "does not
   * add up: {netAmount} net plus {feeAmount} fee" — and the routes used to send
   * the key alone, so an admin was told a refusal happened and nothing about
   * which figure caused it. Carrying the args here, rather than asking each
   * message to live without them, is what makes every such key (including ones
   * added later) render for real. Undefined when the server sent none: that is
   * the path that must stay byte-identical for the many messages naming no
   * figure.
   */
  errorArgs?: Record<string, string>;
  /**
   * The HTTP status of the failed response, when one arrived. Lets a page tell
   * an expected refusal (e.g. a 403 for a role that may not read a route) from
   * a real failure without parsing `message`.
   */
  status?: number;
}

/**
 * `error_args` off a response body, accepted only as a flat map of strings.
 *
 * A body that isn't ours (a proxy's error page, a tampered response) must not be
 * able to hand a page something a substitution would stringify straight into the
 * DOM, so anything else — an array, a nested object, a bare string — is read as
 * "no args", which renders the message unchanged.
 */
function readErrorArgs(data: unknown): Record<string, string> | undefined {
  const raw = (data as { error_args?: unknown } | null | undefined)?.error_args;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") out[name] = value;
    else if (typeof value === "number" || typeof value === "boolean") out[name] = String(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The Error a failed call rejects with: the server's key (or a generic
 * "<path> responded <status>") plus the figures its copy names. */
function apiError(message: string, data: unknown, status?: number): ApiError {
  const err = new Error(message) as ApiError;
  const args = readErrorArgs(data);
  if (args) err.errorArgs = args;
  if (status !== undefined) err.status = status;
  return err;
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
    throw apiError(data.error ?? `${path} failed ${res.status}`, data, res.status);
  }
  // Same guard as apiGet/apiPost/apiPatch/apiDelete below: a non-`/api` route
  // that 303s to /login (as `/setup/restart` did when it was this function's
  // caller — it now goes through apiPost with a CSRF token) gets followed by
  // `fetch`, so `res.ok` would be true and `res.json()` would throw the same
  // raw SyntaxError this whole branch exists to prevent.
  return parseJsonOrThrow<T>(res, path);
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
  throw apiError(data.error ?? `${path} responded ${res.status}`, data, res.status);
}

/** Shared success-path guard for every helper below: `res.ok` doesn't
 * guarantee a JSON body — most commonly, `fetch()` silently follows a 303
 * session/setup redirect (see plugins/auth.ts and plugins/setupGate.ts) and
 * lands on a 200 OK HTML page. Parsing that as JSON throws a raw, unreadable
 * `SyntaxError` straight at the admin; this turns it into one clear message
 * instead. The server-side fix (both hooks now answer `/api/*` with a JSON
 * error, never a redirect) should mean this never fires — this is
 * defense-in-depth for any other 2xx-non-JSON edge case. */
async function parseJsonOrThrow<T>(res: Response, path: string): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(`${path} returned an unexpected response. Reload the page and try again.`);
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "include" });
  if (!res.ok) return throwForResponse(res, path);
  return parseJsonOrThrow<T>(res, path);
}

/** Everything `apiPost` can be asked to do beyond "POST this body". Both are
 * optional; a call that passes neither behaves exactly as it always has. */
export interface PostOptions {
  /** Opaque per-operation key sent as `Idempotency-Key`. The six payment
   * mutations in apps/web-admin/src/routes/api/payments.ts (deliver, refund,
   * cancel, match, credit, dismiss) replay the first attempt's stored response
   * when a retry arrives with the same key and the same request, instead of
   * running the mutation a second time. Minting and holding the key is
   * `useIdempotentPost`'s job (api/idempotency.ts) — pages should call that
   * rather than passing this by hand. */
  idempotencyKey?: string;
  /** Fired the moment the server's response is in hand, before its body is
   * read and whatever the status, with that status. This is what lets
   * `useIdempotentPost` tell a KNOWN outcome from an UNKNOWN one — see its
   * own comment for why the 5xx half of "a response arrived" still counts as
   * unknown. */
  onResponse?: (status: number) => void;
}

/** Attaches the page's CSRF token as a header (see
 * apps/web-admin/src/plugins/auth.ts's csrfCheck, which accepts this header as
 * an alternative to the form-field token HTML forms use). */
export async function apiPost<T>(path: string, body: unknown, options?: PostOptions): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-CSRF-Token": csrfToken(),
  };
  // Sent in the header's canonical mixed casing; Fastify lowercases incoming
  // header names, so the routes read it as `req.headers["idempotency-key"]`.
  if (options?.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify(body),
  });
  options?.onResponse?.(res.status);
  if (!res.ok) return throwForResponse(res, path);
  return parseJsonOrThrow<T>(res, path);
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken() },
    body: JSON.stringify(body),
  });
  if (!res.ok) return throwForResponse(res, path);
  return parseJsonOrThrow<T>(res, path);
}

export async function apiDelete<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    method: "DELETE",
    credentials: "include",
    headers: { "X-CSRF-Token": csrfToken() },
  });
  if (!res.ok) return throwForResponse(res, path);
  return parseJsonOrThrow<T>(res, path);
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
