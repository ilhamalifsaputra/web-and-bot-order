/**
 * Application configuration — zod replacement for Python `config.py`.
 * Validated at startup; malformed values (e.g. ADMIN_IDS) refuse to start the
 * process. One shared schema feeds all services; per-service fields are
 * optional here and checked where actually needed. Bot credentials may also
 * come from the Settings table (plan.md §16) — see @app/core/runtime.
 */
import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Load the monorepo-root `.env` regardless of which app's cwd we boot from
// (e.g. `pnpm --filter @app/order-bot dev` runs with cwd = apps/order-bot).
// Walk up from this module to the workspace root (the dir with
// pnpm-workspace.yaml). dotenv does NOT override already-set vars, so test
// harnesses that set process.env before importing still win, and in Docker
// (vars injected via env_file, no .env present) this is a harmless no-op.
function findRootEnv(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return join(dir, ".env");
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
const rootEnv = findRootEnv();
loadEnv(rootEnv ? { path: rootEnv } : {});

/** Parse "111, 222" → [111, 222]; empty → []. Mirrors Settings.admin_ids. */
const csvNumbers = z
  .string()
  .default("")
  .transform((s) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => Number(x)),
  )
  .pipe(z.array(z.number().int()));

/**
 * Make a schema optional in the "blank means unset" sense: an empty or
 * whitespace-only string is coerced to `undefined` *before* validation, so a
 * left-blank `.env` line (e.g. `BOT_TOKEN=`) boots like the line was absent
 * instead of failing the inner `.min()` check. `.optional()` alone only accepts
 * `undefined`, not `""`.
 */
const blankableOptional = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    inner.optional(),
  );

/** "1"/"true"/"yes"/"on" → true (case-insensitive). Mirrors pydantic bool parsing. */
const looseBool = z
  .string()
  .transform((s) => ["1", "true", "yes", "on"].includes(s.trim().toLowerCase()))
  .or(z.boolean());

export const Env = z.object({
  // ---- Telegram ----
  // Optional since plan.md §16: the primary source is the `bot_token` /
  // `bot_username` Settings rows (web-admin editable, DB wins when filled);
  // env is the bootstrap / recovery fallback. See @app/core/runtime.
  BOT_TOKEN: blankableOptional(z.string().min(20)),
  BOT_USERNAME: blankableOptional(z.string().min(3)),
  ADMIN_IDS: csvNumbers,
  SUPPORT_GROUP_ID: z.coerce.number().optional(),

  // ---- Payment ----
  // Optional: kosong = Binance Pay manual tidak dikonfigurasi (boot tetap jalan).
  BINANCE_PAY_ID: z.string().default(""),
  BINANCE_QR_PATH: z.string().optional(),
  CURRENCY: z.string().default("USDT"),
  PAYMENT_WINDOW_MINUTES: z.coerce.number().default(30),
  USE_UNIQUE_CENTS: looseBool.default(true),

  // ---- Binance Internal Transfer (UID-based, auto-confirmed) ----
  // The Binance UID buyers send USDT to (the note must be the order's paymentRef).
  BINANCE_RECEIVE_UID: z.string().optional(),
  // READ-ONLY API key/secret used only to fetch incoming-transfer history.
  BINANCE_API_KEY: z.string().optional(),
  BINANCE_API_SECRET: z.string().optional(),
  BINANCE_API_BASE: z.string().default("https://api.binance.com"),
  POLL_INTERVAL_SECONDS: z.coerce.number().default(10),
  INTERNAL_PAYMENT_WINDOW_MINUTES: z.coerce.number().default(15),

  // ---- Bybit Internal Transfer (UID→UID, off-chain, instant) ----
  // Our Bybit UID buyers send USDT to via Bybit's own "Internal Transfer"
  // (Bybit account to Bybit account, no blockchain hop). Internal transfers
  // carry no memo, so matching is by the order's unique total amount
  // (USE_UNIQUE_CENTS must stay on). All buyers share this one UID.
  BYBIT_UID: z.string().optional(),
  // Deprecated on-chain BEP20 fields — kept optional so old .env files don't
  // error on load; no longer read anywhere (superseded by BYBIT_UID above).
  BYBIT_DEPOSIT_ADDRESS: z.string().optional(),
  BYBIT_DEPOSIT_CHAIN: z.string().default("BSC"),
  // READ-ONLY API key/secret (Wallet read only — no Withdraw) to fetch deposits.
  BYBIT_API_KEY: z.string().optional(),
  BYBIT_API_SECRET: z.string().optional(),
  BYBIT_API_BASE: z.string().default("https://api.bybit.com"),
  // Window for the auto-confirm path. Internal transfers are instant, but keep
  // a little headroom for poll latency + the buyer's transfer time.
  BYBIT_PAYMENT_WINDOW_MINUTES: z.coerce.number().default(30),
  // Optional USDT→IDR rate; if set, instructions show an IDR equivalent.
  USDT_IDR_RATE: z.coerce.number().optional(),

  // ---- NOWPayments USDT hosted invoice (auto-confirmed by IPN webhook) ----
  // Hosted-invoice crypto needs a looser window than on-chain matching: the
  // buyer has to leave Telegram/the browser, open their wallet app, then come
  // back, before even broadcasting the transfer.
  NOWPAYMENTS_PAYMENT_WINDOW_MINUTES: z.coerce.number().default(30),

  // ---- Database ----
  DATABASE_URL_PRISMA: z.string().default("file:../data/bot.db"),

  // ---- Behaviour ----
  DEFAULT_LANGUAGE: z
    .string()
    .default("en")
    .transform((s) => s.toLowerCase())
    .pipe(z.enum(["en", "id"])),
  RATE_LIMIT_MAX: z.coerce.number().default(5),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().default(3),
  REFERRAL_COMMISSION_PERCENT: z.coerce.number().default(10),
  DEFAULT_WARRANTY_DAYS: z.coerce.number().default(30),
  LOW_STOCK_THRESHOLD: z.coerce.number().default(3),
  TIMEZONE: z.string().default("Asia/Jakarta"),

  // ---- Logging ----
  LOG_LEVEL: z
    .string()
    .default("info")
    .transform((s) => s.toLowerCase())
    .pipe(z.enum(["debug", "info", "warn", "warning", "error"]))
    .transform((s) => (s === "warning" ? "warn" : s)),

  // ---- web-admin ----
  WEB_COOKIE_SECRET: z.string().min(32).optional(),
  WEB_COOKIE_NAME: z.string().default("stockweb_session"),
  WEB_SESSION_TTL_HOURS: z.coerce.number().default(12),
  WEB_LOGIN_RATE_LIMIT_MAX: z.coerce.number().default(5),
  WEB_LOGIN_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().default(600),
  WEB_HOST: z.string().default("127.0.0.1"),
  WEB_PORT: z.coerce.number().default(8000),
  // Mark the session cookie `Secure` (HTTPS-only). Keep false for local http on
  // 127.0.0.1; set true in production behind TLS so the cookie can't leak over
  // a plain-http hop.
  WEB_COOKIE_SECURE: looseBool.default(false),

  // ---- storefront (customer-facing shop) ----
  // Dev/standalone port for the shop app. In the combined server, when
  // SHOP_HOST is unset the shop listens here next to the admin port.
  STOREFRONT_PORT: z.coerce.number().default(8100),
  // Public host the SHOP answers on (e.g. "shop.example.com"). When set, the
  // combined server serves BOTH apps from ONE port and dispatches by Host
  // header: SHOP_HOST → storefront, anything else → web-admin (plan.md §2 F —
  // the single-listener topology managed hosts like Passenger require).
  SHOP_HOST: z.string().optional(),
  // Public storefront origin (no trailing slash) for links in buyer DMs, e.g.
  // https://shop.example.com. Falls back to PUBLIC_URL when unset.
  SHOP_PUBLIC_URL: z.string().url().optional(),

  // ---- Combined single-process server (apps/server) ----
  // 'polling' (default) runs the grammY long-polling runner — used for local dev
  // and the standalone order-bot. 'webhook' mounts the bot as a Fastify route
  // (one HTTP process for web + bot) for managed hosting like Hostinger Business.
  BOT_MODE: z
    .string()
    .default("polling")
    .transform((s) => s.toLowerCase())
    .pipe(z.enum(["polling", "webhook"])),
  // Public HTTPS origin of the deployed app (no trailing slash), e.g.
  // https://shop.example.com — required in webhook mode to register the webhook.
  PUBLIC_URL: z.string().url().optional(),
  // Secret path segment + Telegram secret_token header for the webhook route.
  // Required in webhook mode; keep it long and random. Never log it.
  WEBHOOK_SECRET: z.string().optional(),

  // ---- notifier ----
  NOTIF_BOT_TOKEN: z.string().optional(),
  PUBLIC_CHANNEL_ID: z.coerce.number().optional(),
  NOTIF_POLL_INTERVAL_SECONDS: z.coerce.number().default(10),
  NOTIF_MAX_ATTEMPTS: z.coerce.number().default(5),

  // ---- SMTP (storefront forgot-password email) ----
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  SMTP_SECURE: looseBool.default(false),
});

export type Config = z.infer<typeof Env>;

export const config: Config = Env.parse(process.env);

// Binance Internal Transfer's "enabled" gate is resolved at runtime from
// web-admin Settings (with these BINANCE_* env vars as the fallback) — see
// resolveBinanceInternalConfig() in @app/db, so the receive UID and API
// key/secret can be managed in /settings without a restart.

// Bybit's "enabled" gate is resolved at runtime from web-admin Settings (with
// these BYBIT_* env vars as the fallback) — see resolveBybitConfig() in
// @app/db, so the UID/keys can be managed in /settings without a restart.

/**
 * SMTP is enabled for storefront password-reset emails only when the host and
 * from-address are configured. Otherwise, the mailer is disabled and the
 * password-reset feature is unavailable.
 */
export const isSmtpEnabled = (): boolean => Boolean(config.SMTP_HOST && config.SMTP_FROM);
