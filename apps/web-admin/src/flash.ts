/**
 * Post/Redirect/Get flash helpers + error rendering — port of the flash and
 * error parts of deps.py. A flash is a one-shot message carried in the query
 * string of a 303 redirect (`?msg=...&kind=...`).
 */
import type { FastifyReply } from "fastify";

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
