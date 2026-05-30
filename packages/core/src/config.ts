/**
 * Application configuration — zod replacement for Python `config.py`.
 * Validated at startup; if BOT_TOKEN is missing or ADMIN_IDS malformed the
 * process refuses to start. One shared schema feeds all three services; per
 * service fields are optional here and checked where actually needed.
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

/** "1"/"true"/"yes"/"on" → true (case-insensitive). Mirrors pydantic bool parsing. */
const looseBool = z
  .string()
  .transform((s) => ["1", "true", "yes", "on"].includes(s.trim().toLowerCase()))
  .or(z.boolean());

const Env = z.object({
  // ---- Telegram ----
  BOT_TOKEN: z.string().min(20),
  BOT_USERNAME: z.string().min(3),
  ADMIN_IDS: csvNumbers,
  SUPPORT_GROUP_ID: z.coerce.number().optional(),

  // ---- Payment ----
  BINANCE_PAY_ID: z.string(),
  BINANCE_QR_PATH: z.string().optional(),
  CURRENCY: z.string().default("USDT"),
  PAYMENT_WINDOW_MINUTES: z.coerce.number().default(30),
  USE_UNIQUE_CENTS: looseBool.default(true),

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
  LOG_FILE_PATH: z.string().default("data/logs/bot.log"),
  LOG_BACKUP_COUNT: z.coerce.number().default(5),
  LOG_JSON_FILE: looseBool.default(false),

  // ---- web-admin ----
  WEB_COOKIE_SECRET: z.string().min(32).optional(),
  WEB_COOKIE_NAME: z.string().default("stockweb_session"),
  WEB_SESSION_TTL_HOURS: z.coerce.number().default(12),
  WEB_LOGIN_RATE_LIMIT_MAX: z.coerce.number().default(5),
  WEB_LOGIN_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().default(600),
  WEB_HOST: z.string().default("127.0.0.1"),
  WEB_PORT: z.coerce.number().default(8000),

  // ---- notifier ----
  NOTIF_BOT_TOKEN: z.string().optional(),
  PUBLIC_CHANNEL_ID: z.coerce.number().optional(),
  NOTIF_POLL_INTERVAL_SECONDS: z.coerce.number().default(10),
  NOTIF_MAX_ATTEMPTS: z.coerce.number().default(5),
});

export type Config = z.infer<typeof Env>;

export const config: Config = Env.parse(process.env);

/** True if the given Telegram user ID is in the admin allow-list. */
export const isAdmin = (telegramId: number | bigint): boolean =>
  config.ADMIN_IDS.includes(Number(telegramId));
