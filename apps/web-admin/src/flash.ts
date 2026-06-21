/**
 * Post/Redirect/Get flash helpers + error rendering — port of the flash and
 * error parts of deps.py. A flash is a one-shot message carried in the query
 * string of a 303 redirect (`?msg=...&kind=...`).
 */
import type { FastifyReply, FastifyRequest } from "fastify";

/** 303 redirect carrying a one-shot flash message in the query string. */
export function redirectWithFlash(
  reply: FastifyReply,
  path: string,
  msg: string,
  kind: "success" | "error" | "info" = "success",
): FastifyReply {
  const qs = new URLSearchParams({ msg, kind }).toString();
  const sep = path.includes("?") ? "&" : "?";
  void reply.code(303).redirect(`${path}${sep}${qs}`);
  return reply;
}

/**
 * htmx-aware flash. When the request comes from htmx (`HX-Request` header), the
 * caller wants an in-place update: return JUST the toast partial (200) so the
 * page never reloads or scrolls. Otherwise fall back to the classic
 * Post/Redirect/Get flash — so forms still work with JavaScript disabled.
 */
export function flashOrRedirect(
  req: FastifyRequest,
  reply: FastifyReply,
  path: string,
  msg: string,
  kind: "success" | "error" | "info" = "success",
): FastifyReply {
  if (req.headers["hx-request"] === "true") {
    void reply.code(200).view("_flash.njk", { msg, kind });
    return reply;
  }
  return redirectWithFlash(reply, path, msg, kind);
}

/**
 * Allowlist a client-supplied `return_to` redirect target. Returns `raw` only
 * when it is a safe in-app path under the product/stock admin (so a saved form
 * can land back on the right tab); otherwise `fallback`. Rejects absolute URLs,
 * protocol-relative `//host`, backslashes, and whitespace/control characters —
 * no open-redirect surface. No `return_to` → callers keep their existing
 * default, so behaviour is unchanged unless the new pages opt in.
 */
export function safeReturnTo(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const v = raw.trim();
  if (!v) return fallback;
  if (/[\s\\]/.test(v) || v.includes("://") || v.startsWith("//")) return fallback;
  if (!v.startsWith("/catalog/product/") && !v.startsWith("/stock/")) return fallback;
  return v;
}

/** Turn an AppError/ValidationError (i18n key + args) into a readable sentence. */
export function humanizeValidationError(exc: unknown): string {
  const key = (exc as { key?: string }).key ?? String(exc);
  const args = (exc as { formatArgs?: Record<string, unknown> }).formatArgs ?? {};
  const tail = key.split(".").slice(-1)[0] ?? key;
  let text = tail.replace(/_/g, " ").trim();
  text = text.charAt(0).toUpperCase() + text.slice(1);
  const entries = Object.entries(args);
  if (entries.length) {
    text = `${text} (${entries.map(([k, v]) => `${k}=${v}`).join(", ")})`;
  }
  return text;
}

export function renderError(
  reply: FastifyReply,
  opts: { statusCode: number; title: string; message: string },
): FastifyReply {
  void reply.code(opts.statusCode).view("error.njk", {
    admin: null,
    status_code: opts.statusCode,
    title: opts.title,
    message: opts.message,
  });
  return reply;
}
