/** Read fresh on every call (not cached at module-load time) — this is what
 * makes the CSRF token testable independent of when this module happens to
 * be imported relative to the meta tag existing in the DOM. Clone of the
 * web-admin client (apps/web-admin/client/src/api/client.ts). */
function csrfToken(): string {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") ?? "";
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
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `${path} failed ${res.status}`);
  }
  return res.json() as Promise<T>;
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
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    const err = new Error(data.error ?? `${path} responded ${res.status}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
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
