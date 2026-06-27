/**
 * Nunjucks rendering for the storefront — mirror of web-admin's views plugin
 * with storefront-specific filters:
 *   - `idr`   — central Rupiah price: "Rp79.000" (formatIdr)
 *   - `usdt`  — derived USDT info beside it: "$4.9" (needs the fx rate)
 *   - `localdt` — stored-UTC → config.TIMEZONE display
 * plus the bilingual `t(key, lang, args)` global (@app/core/i18n — same locale
 * files as the bot, EN+ID key sets kept identical per CLAUDE.md).
 *
 * Loader uses TWO paths: storefront views first, then packages/web-ui/views so
 * `_theme.njk` / `_macros.njk` come from the shared theme (plan.md §6).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import nunjucks from "nunjucks";
import { config } from "@app/core/config";
import { localize } from "@app/core/datetime";
import { formatIdr } from "@app/core/formatters";
import { t } from "@app/core/i18n";
import { Decimal } from "@app/core/money";
import { sharedViewsDir } from "@app/web-ui";
import { usdtFromIdr } from "../pricing";

const HERE = dirname(fileURLToPath(import.meta.url));
// Same override convention as web-admin (bundled deploys point this at the
// shipped views dir).
const VIEWS_DIR = process.env.STOREFRONT_VIEWS_DIR ?? join(HERE, "..", "..", "views");

/** Plain money: 4dp string, "—" for null/empty. Used for native USDT amounts
 * (e.g. the USDT credit balance) where no IDR→USDT derivation applies. Mirrors
 * web-admin's `money` filter. */
function moneyFilter(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  try {
    return new Decimal(value as Decimal.Value).toFixed(4);
  } catch {
    return String(value);
  }
}

/** Central IDR price: "Rp79.000". "—" for null/empty. */
function idrFilter(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  try {
    return formatIdr(value as Decimal.Value);
  } catch {
    return String(value);
  }
}

/**
 * Derived USDT info: "$4.9" for an IDR value at `rate`. Empty string when the
 * rate is missing (USDT info hidden — design.md §8b) so templates can simply
 * `{% if fx %}` around it.
 */
function usdtFilter(value: unknown, rate: unknown): string {
  if (value === null || value === undefined || value === "" || !rate) return "";
  try {
    const usdt = usdtFromIdr(value as Decimal.Value, new Decimal(rate as Decimal.Value));
    if (usdt.lessThan(0.01)) return "";
    return `≈ $${usdt.toFixed(2)}`;
  } catch {
    return "";
  }
}

/** Localize a stored UTC datetime to config.TIMEZONE (same as web-admin). */
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
  const env = nunjucks.configure([VIEWS_DIR, sharedViewsDir], {
    autoescape: true,
    noCache: process.env.NODE_ENV !== "production",
  });
  env.addFilter("money", moneyFilter);
  env.addFilter("idr", idrFilter);
  env.addFilter("usdt", usdtFilter);
  env.addFilter("localdt", localdtFilter);
  env.addGlobal("t", t);
  env.addGlobal("tzname", config.TIMEZONE);

  app.decorateReply("view", function (this: FastifyReply, name: string, context: Record<string, unknown> = {}) {
    const html = env.render(name, context);
    void this.header("content-type", "text/html; charset=utf-8").send(html);
    return this;
  });
};

export default fp(viewsPlugin, { name: "storefront-views" });
