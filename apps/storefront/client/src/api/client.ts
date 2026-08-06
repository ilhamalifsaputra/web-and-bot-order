/** Read fresh on every call (not cached at module-load time) — this is what
 * makes the CSRF token testable independent of when this module happens to
 * be imported relative to the meta tag existing in the DOM. Clone of the
 * web-admin client (apps/web-admin/client/src/api/client.ts). */
function csrfToken(): string {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") ?? "";
}

/**
 * Take over the `csrf_token` a response carries, if it carries one.
 *
 * Guest checkout (POST /api/v1/checkout) and order tracking (POST
 * /api/v1/track) mint a session in the MIDDLE of the request that asks for
 * them, so the page holding the conversation was rendered by the shell as an
 * anonymous visitor and its `<meta name="csrf-token">` is empty. Every
 * follow-up request from that page would then fail the server's CSRF check —
 * most painfully for a buyer whose checkout just failed and who wants to fix
 * the email and try again.
 *
 * The token is written back into the meta tag rather than kept in a module
 * variable so the page keeps ONE source of truth for it: `csrfToken()` above,
 * `apiPatch`, and the XHR upload path all read the same place, and a later
 * full page load simply overwrites it with the shell's own value. Pages never
 * touch the tag themselves — they only ever call the API helpers below.
 */
function adoptCsrfToken(data: unknown): void {
  const token = (data as { csrf_token?: unknown } | null | undefined)?.csrf_token;
  if (typeof token !== "string" || token === "") return;
  let meta = document.querySelector('meta[name="csrf-token"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute("name", "csrf-token");
    document.head.appendChild(meta);
  }
  meta.setAttribute("content", token);
}

/**
 * POST without a CSRF token — for the pre-session auth endpoints
 * (/api/v1/auth/login, register, forgot, reset: no customer session exists
 * yet, and the HTML routes they replace carried no CSRF either).
 */
export async function publicPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Tolerant only here: a failing response may not be JSON at all (a proxy's
    // HTML 502), and the caller still needs an Error to render.
    const data = (await res.json().catch(() => ({}))) as { error?: string; csrf_token?: string };
    adoptCsrfToken(data);
    throw new Error(data.error ?? `${path} failed ${res.status}`);
  }
  // Strict on success: a 200 whose body isn't JSON is a broken server, and
  // resolving it as `{}` would hand the caller a payload-shaped hole (a /track
  // response with no `redirect`) to fail on later instead of an error now.
  const data = (await res.json()) as T;
  // POST /api/v1/track answers here, and its 200 carries the freshly minted
  // guest session's CSRF token.
  adoptCsrfToken(data);
  return data;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "include" });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    const err = new Error(data.error ?? `${path} responded ${res.status}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

/** Attaches the page's CSRF token as a header (the storefront csrfCheck in
 * apps/storefront/src/plugins/auth.ts accepts x-csrf-token as an alternative
 * to the form-field token the HTML forms used). Guests may call this with an
 * empty token — the cart routes exempt them, everything else 401s first. */
export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken() },
    body: JSON.stringify(body),
  });
  // Guest checkout's 201 AND its 4xx both carry the guest session's CSRF token
  // once that session exists, so a failed attempt still leaves the page able to
  // retry — but only the error path tolerates a body that isn't JSON (see
  // publicPost above; a malformed 200 must still reject).
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; csrf_token?: string };
    adoptCsrfToken(data);
    const err = new Error(data.error ?? `${path} responded ${res.status}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  const data = (await res.json()) as T;
  adoptCsrfToken(data);
  return data;
}

/** Same CSRF-header contract as `apiPost`, for a multipart `FormData` body
 * (ticket evidence uploads), plus real upload-progress reporting for the
 * (potentially several-MB) attachments — `fetch` has no reliable
 * cross-browser way to report request-upload progress,
 * `XMLHttpRequest.upload.onprogress` does. */
export function apiPostFormWithProgress<T>(
  path: string,
  form: FormData,
  onProgress: (pct: number) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.withCredentials = true;
    xhr.setRequestHeader("X-CSRF-Token", csrfToken());
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let data: { error?: string } = {};
      try {
        data = xhr.responseText ? (JSON.parse(xhr.responseText) as { error?: string }) : {};
      } catch {
        // Not JSON — fall through to the generic message below.
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data as T);
        return;
      }
      const err = new Error(data.error ?? `${path} responded ${xhr.status}`);
      (err as Error & { status?: number }).status = xhr.status;
      reject(err);
    };
    xhr.onerror = () => reject(new Error("Network error during upload."));
    xhr.send(form);
  });
}

/** Same CSRF-header contract as apiPost — for account-scoped edits (e.g.
 * the order-detail info-edit form, Task 10) where PATCH is the more accurate
 * verb than POST. */
export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    const err = new Error(data.error ?? `${path} responded ${res.status}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}
