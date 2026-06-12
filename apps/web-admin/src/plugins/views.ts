/**
 * Nunjucks rendering — port of the Jinja2Templates setup in deps.py.
 * Configures a Nunjucks environment over `views/`, registers the `money` and
 * `localdt` filters, exposes `currency`/`tzname` globals, and decorates
 * `reply.view(name, ctx)` to render + send HTML (Jinja2Templates equivalent).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import nunjucks from "nunjucks";
import { config } from "@app/core/config";
import { localize } from "@app/core/datetime";
import { formatIdr, usdtFromIdr } from "@app/core/formatters";
import { Decimal } from "@app/core/money";
import { sharedViewsDir } from "@app/web-ui";

const HERE = dirname(fileURLToPath(import.meta.url));
// VIEWS_DIR is resolved relative to this source file, which breaks once the app
// is bundled into a single file (import.meta.url then points at dist/). Allow an
// explicit override so the bundled deploy can point at the shipped views/ dir.
// See DEPLOY-HOSTINGER.md §3.
const VIEWS_DIR = process.env.VIEWS_DIR ?? join(HERE, "..", "..", "views");

/** Money: 4dp string, "—" for null/empty. Mirrors deps._money_filter. */
function moneyFilter(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  try {
    return new Decimal(value as Decimal.Value).toFixed(4);
  } catch {
    return String(value);
  }
}

/** Central Rupiah price: "Rp79.000" — same rendering the storefront uses. */
function idrFilter(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  try {
    return formatIdr(value as Decimal.Value);
  } catch {
    return String(value);
  }
}

/** Derived USDT info "$4.9" at the given rate; "" when the rate is unset. */
function usdtFilter(value: unknown, rate: unknown): string {
  if (value === null || value === undefined || value === "" || !rate) return "";
  try {
    return `$${usdtFromIdr(value as Decimal.Value, new Decimal(rate as Decimal.Value)).toString()}`;
  } catch {
    return "";
  }
}

/** Localize a stored UTC datetime to config.TIMEZONE. Mirrors deps._localdt_filter. */
function localdtFilter(value: unknown, fmt = "yyyy-LL-dd HH:mm"): string {
  if (value === null || value === undefined) return "—";
  if (value instanceof Date) return localize(value, fmt);
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? String(value) : localize(d, fmt);
}

declare module "fastify" {
  interface FastifyReply {
    view(name: string, context?: Record<string, unknown>): FastifyReply;
  }
}

const viewsPlugin: FastifyPluginAsync = async (app) => {
  // Two-path loader: app views first, then the shared theme/macros partials
  // (packages/web-ui/views) — app-local templates win, shared ones fall back.
  const env = nunjucks.configure([VIEWS_DIR, sharedViewsDir], { autoescape: true, noCache: process.env.NODE_ENV !== "production" });
  env.addFilter("money", moneyFilter);
  env.addFilter("idr", idrFilter);
  env.addFilter("usdt", usdtFilter);
  env.addFilter("localdt", localdtFilter);
  env.addGlobal("currency", config.CURRENCY);
  env.addGlobal("tzname", config.TIMEZONE);

  app.decorateReply("view", function (this: FastifyReply, name: string, context: Record<string, unknown> = {}) {
    const html = env.render(name, context);
    void this.header("content-type", "text/html; charset=utf-8").send(html);
    return this;
  });
};

export default fp(viewsPlugin, { name: "views" });
