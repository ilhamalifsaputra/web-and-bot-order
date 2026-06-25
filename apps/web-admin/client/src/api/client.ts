const CSRF_TOKEN =
  document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") ?? "";

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "include" });
  if (!res.ok) throw new Error(`${path} responded ${res.status}`);
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
    headers: { "Content-Type": "application/json", "X-CSRF-Token": CSRF_TOKEN },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} responded ${res.status}`);
  return res.json() as Promise<T>;
}
