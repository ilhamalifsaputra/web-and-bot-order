/**
 * GET /metrics — Prometheus exposition-format scrape endpoint for the
 * notification outbox (packages/db/src/crud/notifications.ts). Unauthenticated
 * (no `preHandler`), the same tier as `/healthz` (routes/auth.ts): a
 * Prometheus scraper has no session cookie to present, and these four
 * gauges expose only aggregate counts/ages — no PII or secrets, consistent
 * with `/healthz`'s existing exposure level.
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
import type { FastifyInstance } from "fastify";
import { Registry, Gauge } from "prom-client";
import { prisma, countNotifications, oldestUnsentNotificationAge } from "@app/db";
import { NotificationStatus } from "@app/core/enums";

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

export default async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/metrics", async (_req, reply) => {
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
