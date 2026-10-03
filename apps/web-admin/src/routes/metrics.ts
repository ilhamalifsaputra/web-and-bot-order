/**
 * GET /metrics — Prometheus exposition-format scrape endpoint for the
 * notification outbox (packages/db/src/crud/notifications.ts).
 *
 * Access (backend audit Task C3): this used to be open to anyone on the
 * admin host. The gauges hold no PII, but they leak business volume and
 * delivery health to the public internet, so the route now needs either
 *  - `Authorization: Bearer <token>` matching the `metrics_token` Setting
 *    (falling back to the `METRICS_TOKEN` env var) — what a scraper sends, or
 *  - an owner (super) admin session — for eyeballing it from a browser.
 * With no token configured and no owner session it is closed (403); a
 * configured token that is missing or wrong gets 401.
 *
 * Each gauge is computed fresh from a live query on every scrape
 * (`oldestUnsentNotificationAge` / `countNotifications`) rather than on a
 * polling cadence — a deliberate deviation from this project's usual
 * cron-poll pattern (`outboxDispatcherPollWatchdog`, `jobs/index.ts`), which
 * exists to page admins on a schedule. A `/metrics` read is a cheap,
 * on-demand, side-effect-free aggregate query (a single indexed COUNT or
 * findFirst each), so computing it fresh at scrape time is simpler than a
 * background poller and avoids a stale-value window between polls.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Registry, Gauge } from "prom-client";
import { prisma, countNotifications, getSetting, oldestUnsentNotificationAge } from "@app/db";
import { config } from "@app/core/config";
import { NotificationStatus } from "@app/core/enums";
import { constantTimeEqual } from "../auth";
import { optionalAdmin } from "../plugins/auth";

/** Setting key holding the scraper's bearer token (masked as a secret in Settings). */
export const METRICS_TOKEN_KEY = "metrics_token";

// Module-level singleton registry/gauges (prom-client's own recommended
// pattern — see its README's "how to use" example) so buildApp() can be
// called more than once per process (as web-admin's own tests do, once per
// test file) without prom-client throwing "A metric with the name ... has
// already been registered" against its global default registry. A private
// Registry instance, not `prom-client`'s `register` singleton, keeps these
// three gauges isolated to this route.
const registry = new Registry();

const oldestUnsentAgeGauge = new Gauge({
  name: "outbox_oldest_unsent_age_seconds",
  help: "Age in seconds of the oldest unsent notification outbox row (PENDING, or SENDING with a claim older than the stale-claim window). Absent from the scrape when the outbox has no such row.",
  registers: [registry],
});

const backlogSizeGauge = new Gauge({
  name: "outbox_backlog_size",
  help: "Count of PENDING notification outbox rows awaiting delivery.",
  registers: [registry],
});

const deadLetterCountGauge = new Gauge({
  name: "outbox_dead_letter_count",
  help: "Count of DEAD_LETTER notification outbox rows (exhausted every delivery attempt without ever sending).",
  registers: [registry],
});

const failedCountGauge = new Gauge({
  name: "outbox_failed_count",
  help: "Count of FAILED notification outbox rows (permanently invalid — malformed payload, missing template, or similar — never eligible for retry). May include benign cases like a customer blocking the bot; not itself an alert-worthy signal without downstream filtering.",
  registers: [registry],
});

/** The configured scrape token: the `metrics_token` Setting, else the env var. Blank counts as unset. */
async function configuredMetricsToken(): Promise<string | null> {
  const fromSetting = ((await getSetting(prisma, METRICS_TOKEN_KEY)) ?? "").trim();
  if (fromSetting) return fromSetting;
  const fromEnv = (config.METRICS_TOKEN ?? "").trim();
  return fromEnv || null;
}

/** Decide whether this request may read /metrics; sends the refusal itself and returns false if not. */
async function metricsAccessOk(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const header = req.headers.authorization;
  const presented = typeof header === "string" && /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, "").trim() : "";
  const token = await configuredMetricsToken();
  if (token && presented && constantTimeEqual(presented, token)) return true;
  const admin = await optionalAdmin(req);
  if (admin?.role === "super") return true;
  if (!token) {
    void reply.code(403).send({ error: "Metrics are disabled until a metrics token is configured." });
  } else {
    void reply.code(401).header("WWW-Authenticate", "Bearer").send({ error: "A valid metrics bearer token is required." });
  }
  return false;
}

export default async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/metrics", async (req, reply) => {
    if (!(await metricsAccessOk(req, reply))) return reply;
    const [oldestUnsentAge, backlogSize, deadLetterCount, failedCount] = await Promise.all([
      oldestUnsentNotificationAge(prisma),
      countNotifications(prisma, { status: NotificationStatus.PENDING }),
      countNotifications(prisma, { status: NotificationStatus.DEAD_LETTER }),
      countNotifications(prisma, { status: NotificationStatus.FAILED }),
    ]);

    // A label-less prom-client Gauge is NOT bare/absent by default: its base
    // Metric constructor calls Gauge#reset(), which for zero label names
    // immediately writes a {value: 0} sample into the gauge's internal
    // hashMap (node_modules/prom-client/lib/gauge.js `reset()`, called from
    // /lib/metric.js's constructor) — so simply never calling `.set()` still
    // renders a misleading `outbox_oldest_unsent_age_seconds 0` line on
    // every scrape, both before the first real value and on any later scrape
    // where the outbox has since emptied out. `.remove()` (no label args)
    // deletes that hashMap entry outright, which is what makes
    // Registry#metrics() print only the `# HELP`/`# TYPE` lines for this
    // gauge with no value line for that scrape — confirmed by reading
    // lib/gauge.js's `reset()`/`remove()` and lib/registry.js's
    // `getMetricsAsString()` (which loops `metric.values || []` and simply
    // emits zero sample lines when that array is empty, verified directly
    // in the installed prom-client@15.1.3 package, not assumed from docs).
    if (oldestUnsentAge === null) {
      oldestUnsentAgeGauge.remove();
    } else {
      oldestUnsentAgeGauge.set(oldestUnsentAge);
    }
    backlogSizeGauge.set(backlogSize);
    deadLetterCountGauge.set(deadLetterCount);
    failedCountGauge.set(failedCount);

    reply.header("Content-Type", registry.contentType);
    return registry.metrics();
  });
}
