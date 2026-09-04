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
 *
 * The design-token values `/static/app.css`'s component classes reference now
 * live in the SPA bundle's own CSS (client/src/styles/tokens.css), which this
 * build-free path never loads — so a tiny literal `:root` block is inlined
 * below to keep `.card`/`.btn`/`.wait-dot` rendering on the last-resort page.
 * It is the ONE deliberate duplicate of tokens.css, scoped to this shell only.
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

/* Literal mirror of client/src/styles/tokens.css's legacy-name aliases — the
   values /static/app.css's component classes need when this build-free shell
   loads app.css without the SPA bundle. Keep in sync with tokens.css. */
const FALLBACK_TOKENS = `:root{--paper:#f6f8fb;--card:#ffffff;--sand:#eef1f6;--line:#e3e8ef;--ink:#1b2330;--ink-soft:#5a6473;--ink-faint:#677288;--pine:#2563eb;--pine-dark:#1d4ed8;--pine-tint:#e6effe;--grass:#16a34a;--grass-dark:#15803d;--grass-tint:#e7f6ec;--amberx:#b45c0a;--amberx-tint:#fdedcf;--rust:#dc2626;--rust-dark:#b91c1c;--rust-tint:#fde7e7;--accent:#2563eb;--pine-rgb:37 99 235;--r-xs:.25rem;--r-sm:.5rem;--r-md:.75rem;--r-lg:1rem;--r-pill:9999px}`;

function staticFallbackHtml(opts: SpecialShellOpts): string {
  return `<!doctype html>
<html lang="${esc(opts.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
<style>${FALLBACK_TOKENS}</style>
<link rel="stylesheet" href="/static/app.css">
</head>
<body class="min-h-screen flex items-center justify-center bg-sand text-ink">
  ${opts.fallbackBodyHtml}
</body>
</html>
`;
}
