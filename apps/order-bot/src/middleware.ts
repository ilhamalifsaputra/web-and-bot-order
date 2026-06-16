/**
 * Cross-cutting middleware — port of bot/utils/decorators.py + main.py's
 * group -2 update_id binder.
 *
 *  - bindUpdateId : run the rest of the update under the logging contextvar.
 *  - registeredUser: upsert the User row, cache a snapshot on the session,
 *    sync session.lang, and block banned users (mirrors @registered_user).
 *  - rateLimit    : per-user sliding-window guard (@rate_limit).
 *  - adminOnly    : guard a composer/handler to ADMIN_IDS (@admin_only).
 *
 * @safe_handler (per-handler try/except) becomes the global `bot.catch`.
 */
import type { MiddlewareFn } from "grammy";
import { config } from "@app/core/config";
import { isAdmin } from "@app/core/runtime";
import { langCode } from "@app/core/enums";
import { logger, withUpdateId } from "@app/core/logger";
import { prisma, upsertUser } from "@app/db";
import type { MyContext } from "./context";
import { t } from "./util/i18n";

/** group -2: bind update_id into the logging context for this update. */
export const bindUpdateId: MiddlewareFn<MyContext> = (ctx, next) =>
  withUpdateId(ctx.update.update_id, next);

/** Auto-register the user, cache a snapshot, sync language, block bans. */
export const registeredUser: MiddlewareFn<MyContext> = async (ctx, next) => {
  const from = ctx.from;
  if (!from) return next();

  const user = await upsertUser(prisma, {
    telegramId: from.id,
    username: from.username ?? null,
    fullName: [from.first_name, from.last_name].filter(Boolean).join(" ") || null,
  });

  ctx.session.lang = langCode(user.language);

  if (user.banned) {
    logger.info(`Banned user ${from.id} blocked`);
    const msg = t(ctx, "error.banned", { reason: user.bannedReason ?? "-" });
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: msg, show_alert: true });
    else await ctx.reply(msg);
    return; // short-circuit
  }

  ctx.session.dbUser = {
    id: user.id,
    telegramId: String(user.telegramId),
    role: user.role,
    language: user.language,
    referralCode: user.referralCode,
    walletBalance: String(user.walletBalance),
  };
  return next();
};

// --- rate limit (sliding window, in-memory) -------------------------------

const buckets = new Map<number, number[]>();

export const rateLimit: MiddlewareFn<MyContext> = async (ctx, next) => {
  const from = ctx.from;
  if (!from) return next();
  const now = Date.now() / 1000;
  const window = config.RATE_LIMIT_WINDOW_SECONDS;
  const max = config.RATE_LIMIT_MAX;
  const dq = buckets.get(from.id) ?? [];
  while (dq.length && dq[0]! <= now - window) dq.shift();
  if (dq.length >= max) {
    logger.warn(`Rate limit hit for user ${from.id}`);
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx, "error.rate_limited") });
    buckets.set(from.id, dq);
    return; // drop silently
  }
  dq.push(now);
  buckets.set(from.id, dq);
  return next();
};

/** Guard: only ADMIN_IDS proceed; others get a polite refusal. */
export const adminOnly: MiddlewareFn<MyContext> = async (ctx, next) => {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    logger.warn(`Non-admin ${ctx.from?.id} tried an admin action`);
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx, "error.admin_only"), show_alert: true });
    else if (ctx.message) await ctx.reply(t(ctx, "error.admin_only"));
    return;
  }
  return next();
};
