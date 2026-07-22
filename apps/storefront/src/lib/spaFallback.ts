/**
 * Serves the React SPA shell for the 3 full-page states that must override
 * normal client routing — the storefront's first-run setup gate (503) and
 * Fastify's own error (500) / not-found (404) handlers — used by
 * plugins/setupGate.ts and server.ts. This replaces what used to be 3
 * separate `reply.view("...njk", ...)` calls.
 *
 * The built `index.html` gets the same placeholder substitution
 * routes/spaShell.ts does, plus one caller-supplied <meta> tag that
 * client/src/main.tsx reads at boot to decide whether to mount
 * SetupPendingPage/ErrorPage directly instead of the normal router.
 *
 * If reading the built index.html itself throws — the one case Nunjucks used
 * to guarantee against: a fresh clone before `pnpm build` has ever run, or the
 * dist directory otherwise missing/corrupt — this falls back to a hand-written
 * HTML string with zero template-engine and zero build dependency, styled via
 * `/static/app.css` (a source-controlled file, not a build artifact, so it's
 * always present regardless of whether the SPA has been built).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyReply } from "fastify";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = process.env.STOREFRONT_STATIC_DIR ?? join(HERE, "..", "..", "static");
export const SPA_INDEX_PATH = join(STATIC_DIR, "shop-app", "index.html");

/** Minimal HTML escape for text interpolated into the shell or the fallback. */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface SpecialShellOpts {
  /** HTTP status to send — 503 (setup pending), 500, or 404. */
  status: number;
  lang: string;
  /** Injected before `</head>` in the built shell, e.g. `<meta name="setup-pending" content="true">` — read by main.tsx to decide what to mount. */
  metaTag: string;
  title: string;
  /** Inner markup for the crawler/no-JS `#seo-shell` div — plain semantic HTML, already escaped by the caller. */
  seoBodyHtml: string;
  /** Full `<main>...</main>` markup for the hand-written last-resort page — must only reference classes from `/static/app.css` (`.card`, `.btn`, `.wait-dot`, Tailwind utility tokens), already escaped by the caller. */
  fallbackBodyHtml: string;
}

/**
 * Serves the built SPA shell (with an injected meta tag + a small crawler/no-JS
 * body block) for `opts.status`, or the hand-written last-resort HTML if the
 * shell itself can't be read.
 */
export function renderSpecialShell(reply: FastifyReply, opts: SpecialShellOpts): void {
  try {
    const html = readFileSync(SPA_INDEX_PATH, "utf-8")
      .replace("__CSRF_TOKEN__", "")
      .replace("__LANG__", () => opts.lang)
      .replace("__TITLE__", () => esc(opts.title))
      .replace("<!--__HEAD_META__-->", () => opts.metaTag)
      .replace("<!--__SEO_BODY__-->", () => `<div id="seo-shell">${opts.seoBodyHtml}</div>`);
    void reply.code(opts.status).type("text/html; charset=utf-8").send(html);
  } catch {
    void reply.code(opts.status).type("text/html; charset=utf-8").send(staticFallbackHtml(opts));
  }
}

function staticFallbackHtml(opts: SpecialShellOpts): string {
  return `<!doctype html>
<html lang="${esc(opts.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
<link rel="stylesheet" href="/static/app.css">
</head>
<body class="min-h-screen flex items-center justify-center bg-sand text-ink">
  ${opts.fallbackBodyHtml}
</body>
</html>
`;
}
