/**
 * Combined single-process composition root.
 *
 * One Node process serves EVERYTHING the three standalone services do:
 *   - the Fastify web-admin (all existing plugins/routes, reused as-is);
 *   - the grammY order-bot, either long-polling (dev) or mounted as a webhook
 *     route on the SAME Fastify (managed hosting like Hostinger Business);
 *   - the in-process workers: notifier outbox drain, Binance poller, croner jobs.
 *
 * A single process is the safe topology for the shared single-writer SQLite DB
 * (one PrismaClient, WAL) and means each worker runs exactly once with no
 * double-run risk. Transport is chosen by `BOT_MODE` (polling | webhook).
 *
 * `buildServer()` is pure construction (app + bot + routes, no network/timers)
 * so tests can drive it with `app.inject()`. `start()` performs the
 * side-effectful boot and graceful shutdown, and runs only as the entry point.
 */
import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { Bot, webhookCallback } from "grammy";
import { run } from "@grammyjs/runner";
import { config } from "@app/core/config";
import { botToken as runtimeBotToken, notifBotToken, setBotIdentity } from "@app/core/runtime";
import { logger } from "@app/core/logger";
import { initDb, prisma, resolveBotCredentials } from "@app/db";
import { buildBot, setupCommandMenu } from "@app/order-bot/main";
import { scheduleJobs, scheduleFxRefresh } from "@app/order-bot/jobs";
import { startPolling, stopPolling } from "@app/order-bot/payments/binanceInternal";
import { buildApp } from "@app/web-admin/server";
import { buildApp as buildShopApp } from "@app/storefront/server";
import { runDispatcher } from "@app/notifier/dispatcher";

/** Update types we subscribe to — identical in polling and webhook mode. */
const ALLOWED_UPDATES = ["message", "edited_message", "callback_query", "my_chat_member"] as const;

type BotMode = "polling" | "webhook";

/** The Fastify instance type, derived to avoid a direct `fastify` dependency. */
type AppInstance = Awaited<ReturnType<typeof buildApp>>;
type ShopInstance = Awaited<ReturnType<typeof buildShopApp>>;

export interface ServerOptions {
  /** Override `config.BOT_MODE` (handy for tests). */
  mode?: BotMode;
  /** Override `config.WEBHOOK_SECRET` (handy for tests). */
  webhookSecret?: string;
  /**
   * Boot-resolved bot token (Setting wins, env fallback — plan.md §16.3).
   * Omitted → the runtime/env value; explicit null → no token anywhere, the
   * web still serves but the bot stays off (bootstrap case, §16.3).
   */
  botToken?: string | null;
}

export interface BuiltServer {
  app: AppInstance;
  /** The customer-facing storefront (plan.md) — same process, same PrismaClient. */
  shop: ShopInstance;
  /** Null when no bot token is configured anywhere (web-only boot, §16.3). */
  bot: ReturnType<typeof buildBot> | null;
  mode: BotMode;
}

/**
 * Which app should answer a request, by Host header (plan.md §2 decision F:
 * one process, one public listener, storefront vs admin split by subdomain).
 * The shop host wins; everything else — admin domain, bare IP, the Telegram
 * webhook POST — stays on the admin app. Exported for tests.
 */
export function dispatchByHost(hostHeader: string | undefined, shopHost: string): "shop" | "admin" {
  const host = (hostHeader ?? "").split(":")[0]!.trim().toLowerCase();
  return host !== "" && host === shopHost ? "shop" : "admin";
}

/** Hostname of SHOP_PUBLIC_URL, or null when unset (→ separate-port mode). */
export function shopHostFromConfig(): string | null {
  if (!config.SHOP_PUBLIC_URL) return null;
  try {
    return new URL(config.SHOP_PUBLIC_URL).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Build the Fastify apps (admin + storefront) + grammY bot and wire the health
 * and (in webhook mode) the webhook routes. No DB init, no network, no timers
 * — safe for tests.
 */
export async function buildServer(opts: ServerOptions = {}): Promise<BuiltServer> {
  const mode: BotMode = opts.mode ?? config.BOT_MODE;
  const webhookSecret = opts.webhookSecret ?? config.WEBHOOK_SECRET;

  const app = await buildApp();
  const shop = await buildShopApp();

  // Liveness probe (GET /healthz, returns {status:"ok"} + a DB ping) is already
  // provided by the web-admin auth routes — reused here, so platform health
  // checks / uptime pings keep this single process warm. No duplicate route.
  // The storefront ships its own /healthz for the shop domain.

  // sequentialize (per-chat) is wired inside buildBot(), so conversation update
  // order is preserved in webhook mode too — see apps/order-bot/src/main.ts.
  // No token anywhere → the web keeps serving and the bot stays off until an
  // admin fills `bot_token` in Settings and restarts (plan.md §16.3).
  const token = opts.botToken !== undefined ? opts.botToken : runtimeBotToken() ?? null;
  const bot = token ? buildBot(token) : null;
  if (!bot) {
    logger.warn("Bot token not configured — web serves, bot is OFF (Settings → bot token, then restart)");
  }

  if (mode === "webhook" && bot) {
    if (!webhookSecret) {
      throw new Error("WEBHOOK_SECRET is required when BOT_MODE=webhook");
    }
    // The secret path segment + the X-Telegram-Bot-Api-Secret-Token header
    // together gate the route; grammY answers 401 on a header mismatch before
    // the update ever reaches the bot.
    app.post(
      `/tg/${webhookSecret}`,
      webhookCallback(bot, "fastify", { secretToken: webhookSecret }),
    );
  }

  return { app, shop, bot, mode };
}

/**
 * Start the public-channel outbox drain loop in-process. Uses the dedicated
 * NOTIF_BOT_TOKEN bot when configured, otherwise falls back to the main bot
 * (which must be an admin of PUBLIC_CHANNEL_ID). No-op without PUBLIC_CHANNEL_ID.
 * Returns the loop promise so shutdown can await it after aborting the signal.
 */
async function startNotifier(mainBot: ReturnType<typeof buildBot> | null, signal: AbortSignal): Promise<void> {
  if (config.PUBLIC_CHANNEL_ID === undefined) {
    logger.info("Notifier disabled (PUBLIC_CHANNEL_ID not set)");
    return;
  }
  // Reuse the main bot unless a separate notifier token is configured (Setting
  // wins, env fallback — stamped into the runtime at boot). The cast is safe:
  // the dispatcher only touches `bot.api`, which is invariant in C.
  const dedicated = notifBotToken();
  if (!dedicated && !mainBot) {
    logger.warn("Notifier disabled (no notifier token and the main bot is off)");
    return;
  }
  const notifBot: Bot = dedicated ? new Bot(dedicated) : (mainBot as unknown as Bot);
  if (dedicated) await notifBot.init();
  logger.info(
    `Notifier started -> channel ${config.PUBLIC_CHANNEL_ID} ` +
      `(token=${dedicated ? "dedicated" : "main-bot"})`,
  );
  try {
    await runDispatcher(notifBot, signal);
  } catch (err) {
    logger.error({ err }, "Notifier dispatcher exited unexpectedly");
  }
}

/** Side-effectful boot: DB, command menu, workers, transport, listen, shutdown. */
export async function start(): Promise<void> {
  await initDb(); // single PrismaClient, sets WAL + busy_timeout PRAGMAs

  // Resolve bot credentials ONCE (Setting wins, env fallback — plan.md §16.3)
  // and stamp them for the synchronous consumers (referral links, Telegram
  // Login HMAC, admin file downloads). A token edit needs a restart (§16.2).
  const creds = await resolveBotCredentials(prisma);
  setBotIdentity({
    botToken: creds.botToken ?? undefined,
    botUsername: creds.botUsername ?? undefined,
    notifBotToken: creds.notifBotToken ?? undefined,
  });

  const { app, shop, bot, mode } = await buildServer({ botToken: creds.botToken });

  // Bot-side boot — all skipped when no token is configured (web-only boot).
  let jobs: ReturnType<typeof scheduleJobs> = [];
  if (bot) {
    // bot_username may be unset in Settings/env — getMe fills it. Best-effort.
    try {
      setBotIdentity({ botUsername: (await bot.api.getMe()).username });
    } catch (err) {
      logger.warn({ err }, "getMe failed; using configured bot_username if any");
    }
    // Best-effort command menu (logs internally, never throws).
    await setupCommandMenu(bot);
    // In-process workers — exactly one instance each (single process).
    jobs = scheduleJobs(bot.api);
    startPolling(bot.api);
  }
  // Market-rate auto-update needs no bot — runs even on a web-only boot.
  jobs = [...jobs, scheduleFxRefresh()];
  const notifierAbort = new AbortController();
  const notifierDone = startNotifier(bot, notifierAbort.signal);

  const host = process.env.WEB_HOST ?? (mode === "webhook" ? "0.0.0.0" : config.WEB_HOST);
  const port = Number(process.env.PORT ?? config.WEB_PORT);

  // Two listen topologies (plan.md §2 decision F):
  //  - SHOP_PUBLIC_URL set → ONE public listener (Passenger gives one port);
  //    requests for the shop hostname go to the storefront, everything else
  //    (admin domain, /tg webhook, health pings) to the admin app.
  //  - unset (dev / VPS) → admin on WEB_PORT and storefront on STOREFRONT_PORT.
  const shopHost = shopHostFromConfig();
  let front: Server | undefined;
  if (shopHost) {
    await app.ready();
    await shop.ready();
    // Each Fastify owns a non-listening http.Server whose request handler is
    // attached at construction; emitting "request" routes into that app.
    front = createServer((req, res) => {
      const target = dispatchByHost(req.headers.host, shopHost) === "shop" ? shop : app;
      target.server.emit("request", req, res);
    });
    await new Promise<void>((resolve, reject) => {
      front!.once("error", reject);
      front!.listen(port, host, resolve);
    });
    logger.info(
      `Server listening on http://${host}:${port} (BOT_MODE=${mode}, shop host=${shopHost}, others→admin)`,
    );
  } else {
    await app.listen({ host, port });
    await shop.listen({ host, port: config.STOREFRONT_PORT });
    logger.info(
      `Server listening on http://${host}:${port} (BOT_MODE=${mode}); storefront on :${config.STOREFRONT_PORT}`,
    );
  }

  let runner: ReturnType<typeof run> | undefined;
  if (!bot) {
    logger.warn("Bot transport skipped — no token. Fill Settings → bot token, then restart.");
  } else if (mode === "webhook") {
    if (!config.PUBLIC_URL || !config.WEBHOOK_SECRET) {
      throw new Error("PUBLIC_URL and WEBHOOK_SECRET are required when BOT_MODE=webhook");
    }
    await bot.init(); // webhook handler needs botInfo before handling updates
    const url = `${config.PUBLIC_URL.replace(/\/+$/, "")}/tg/${config.WEBHOOK_SECRET}`;
    await bot.api.setWebhook(url, {
      secret_token: config.WEBHOOK_SECRET,
      drop_pending_updates: true,
      allowed_updates: [...ALLOWED_UPDATES],
    });
    logger.info("Webhook registered"); // never log the URL — it carries the secret
  } else {
    // Clear any webhook left over from a previous webhook deploy, then poll.
    try {
      await bot.api.deleteWebhook({ drop_pending_updates: true });
    } catch (err) {
      logger.warn({ err }, "deleteWebhook failed (continuing; pending updates not dropped)");
    }
    runner = run(bot, { runner: { fetch: { allowed_updates: [...ALLOWED_UPDATES] } } });
    logger.info("Order bot started (long polling)");
  }

  // Graceful shutdown: stop producers in dependency order, then the server/DB.
  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${sig}, shutting down…`);
    try {
      for (const job of jobs) job.stop();
      stopPolling();
      notifierAbort.abort();
      await notifierDone; // let the drain loop unwind
      if (runner?.isRunning()) await runner.stop();
      if (mode === "webhook" && bot) {
        try {
          await bot.api.deleteWebhook();
        } catch {
          /* best-effort */
        }
      }
      if (front) await new Promise<void>((resolve) => front!.close(() => resolve()));
      await app.close();
      await shop.close();
      await prisma.$disconnect();
    } catch (err) {
      logger.error({ err }, "Error during shutdown");
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

// Boot only as the real entry point: directly via tsx/node, or as the bundled
// dist/server.cjs. (The imported order-bot/web-admin/notifier entries suppress
// their own self-start, so only this module drives boot.)
const isEntry =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  start().catch((err) => {
    logger.error({ err }, "Fatal error during startup");
    process.exit(1);
  });
}
