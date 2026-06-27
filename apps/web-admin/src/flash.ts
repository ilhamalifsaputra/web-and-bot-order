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
 * Flash helper for settings.ts callsites.  For plain browser requests this
 * does a 303 redirect carrying the message in the query string.  For HTMX
 * requests (HX-Request header present) it returns a 200 with a minimal inline
 * HTML toast so the SPA can swap it in without a full-page navigation.
 */
export function flashOrRedirect(
  req: FastifyRequest,
  reply: FastifyReply,
  path: string,
  msg: string,
  kind: "success" | "error" | "info" = "success",
): FastifyReply {
  if (req.headers["hx-request"] === "true") {
    const color = kind === "error" ? "#c0392b" : kind === "info" ? "#2980b9" : "#27ae60";
    const safe = msg.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const html =
      `<div style="padding:0.5rem 1rem;background:${color};color:#fff;border-radius:4px">` +
      `${safe}</div>`;
    void reply.code(200).header("content-type", "text/html; charset=utf-8").send(html);
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
  const safeTitle = opts.title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const safeMsg = opts.message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html =
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">` +
    `<title>${opts.statusCode} ${safeTitle}</title></head><body>` +
    `<h1>${opts.statusCode} — ${safeTitle}</h1><p>${safeMsg}</p>` +
    `</body></html>`;
  void reply.code(opts.statusCode).header("content-type", "text/html; charset=utf-8").send(html);
  return reply;
}
