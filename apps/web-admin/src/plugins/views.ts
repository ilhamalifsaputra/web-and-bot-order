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
import { Decimal } from "@app/core/money";

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWS_DIR = join(HERE, "..", "..", "views");

/** Money: 4dp string, "—" for null/empty. Mirrors deps._money_filter. */
function moneyFilter(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  try {
    return new Decimal(value as Decimal.Value).toFixed(4);
  } catch {
    return String(value);
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
  const env = nunjucks.configure(VIEWS_DIR, { autoescape: true, noCache: process.env.NODE_ENV !== "production" });
  env.addFilter("money", moneyFilter);
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
