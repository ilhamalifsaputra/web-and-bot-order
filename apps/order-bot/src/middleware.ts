/**
 * Cross-cutting middleware — port of bot/utils/decorators.py + main.py's
 * group -2 update_id binder.
 *
 *  - bindUpdateId : run the rest of the update under the logging contextvar.
 *  - registeredUser: upsert the User row, cache a snapshot on the session,
 *    sync session.lang, and block banned users (mirrors @registered_user).
 *  - rateLimit    : per-user sliding-window guard (@rate_limit).
 *  - adminOnly    : guard a composer/handler to ADMIN_IDS (@admin_only).
 *  - joinGate     : block every interaction until the configured join-gate
 *    channel/group have been joined.
 *
 * @safe_handler (per-handler try/except) becomes the global `bot.catch`.
 */
import type { MiddlewareFn } from "grammy";
import { InlineKeyboard } from "grammy";
import { config } from "@app/core/config";
import { isAdmin } from "@app/core/runtime";
import { langCode } from "@app/core/enums";
import { logger, withUpdateId } from "@app/core/logger";
import { prisma, upsertUser, peekWarmUser, primeWarmUser, getSetting, type WarmUserSnap } from "@app/db";
import type { MyContext } from "./context";
import { t } from "./util/i18n";
import * as ckb from "./keyboards/customer";

/** group -2: bind update_id into the logging context for this update. */
export const bindUpdateId: MiddlewareFn<MyContext> = (ctx, next) =>
  withUpdateId(ctx.update.update_id, next);

/** Matches a `/start ref_<code>` deep link, tolerating a `@botname` suffix
 * (e.g. `/start@shopbot ref_ABC123`) the way grammY's own command matching
 * does. Read directly off the raw text since this runs before grammY's
 * command router populates `ctx.match`. */
const START_REF_RE = /^\/start(?:@\S+)?\s+ref_(\S+)/;

/**
 * Auto-register the user, cache a snapshot, sync language, block bans.
 *
 * Skips the per-update `upsertUser` DB write when a warm cache entry exists
 * and the Telegram-supplied username/full name haven't changed — the common
 * case for an active chat. Every mutation that can make the cache stale
 * (role/ban/language/wallet changes) invalidates it via `invalidateWarmUser`
 * in packages/db/src/crud/users.ts, so a miss always falls back to a fresh
 * `upsertUser` read.
 *
 * Also credits a `/start ref_<code>` deep link's referral on first sight.
 * This has to happen HERE, not in `startCommand`: this middleware is what
 * actually creates the User row for a brand-new customer (it runs before
 * every command handler, including `/start`), and `upsertUser` only ever
 * applies `referredByCode` on the row's initial creation — by the time a
 * later handler calls `upsertUser` again for the same user, the row already
 * exists and the referral code is silently ignored. Attributing it here is
 * what makes referral credit survive downstream gates (like `joinGate`)
 * that can block the update before `startCommand` ever runs.
 */
export const registeredUser: MiddlewareFn<MyContext> = async (ctx, next) => {
  const from = ctx.from;
  if (!from) return next();

  const telegramIdKey = String(from.id);
  const fullName = [from.first_name, from.last_name].filter(Boolean).join(" ") || null;
  const username = from.username ?? null;

  const warm = peekWarmUser(telegramIdKey);
  let snap: WarmUserSnap;
  if (warm && warm.username === username && warm.fullName === fullName) {
    snap = warm;
  } else {
    const referredByCode = ctx.message?.text?.match(START_REF_RE)?.[1];
    const user = await upsertUser(prisma, { telegramId: from.id, username, fullName, referredByCode });
    snap = {
      id: user.id,
      telegramId: telegramIdKey,
      username: user.username,
      fullName: user.fullName,
      role: user.role,
      language: user.language,
      referralCode: user.referralCode,
      walletBalance: String(user.walletBalance),
      banned: user.banned,
      bannedReason: user.bannedReason,
      syncedAt: Date.now(),
    };
    primeWarmUser(telegramIdKey, snap);
  }

  ctx.session.lang = langCode(snap.language);

  if (snap.banned) {
    logger.info(`Banned user ${from.id} tried to use the bot — blocked and shown the ban-reason message`);
    const msg = t(ctx, "error.banned", { reason: snap.bannedReason ?? "-" });
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: msg, show_alert: true });
    else await ctx.reply(msg);
    return; // short-circuit
  }

  ctx.session.dbUser = {
    id: snap.id,
    telegramId: snap.telegramId,
    role: snap.role,
    language: snap.language,
    referralCode: snap.referralCode,
    walletBalance: snap.walletBalance,
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
    logger.warn(`User ${from.id} exceeded the rate limit (${max} actions per ${window}s) — this update is dropped silently`);
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx, "error.rate_limited") });
    buckets.set(from.id, dq);
    return; // drop silently
  }
  dq.push(now);
  if (dq.length) buckets.set(from.id, dq);
  else buckets.delete(from.id);
  return next();
};

/** Guard: only ADMIN_IDS proceed; others get a polite refusal. */
export const adminOnly: MiddlewareFn<MyContext> = async (ctx, next) => {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    logger.warn(`User ${ctx.from?.id} tried an admin-only action without admin rights — refused`);
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx, "error.admin_only"), show_alert: true });
    else await ctx.reply(t(ctx, "error.admin_only"));
    return;
  }
  return next();
};

// --- join gate (block until the configured channel/group are joined) ------

interface GateCacheEntry {
  channelOk: boolean;
  groupOk: boolean;
  checkedAt: number;
}

const JOIN_GATE_CACHE_TTL_MS = 5 * 60 * 1000;
/** telegram user id -> last verdict. Module-level (not per-request) so repeat
 * updates from the same not-yet-joined user don't re-hit getChatMember on
 * every tap/message within the TTL. */
const joinGateCache = new Map<number, GateCacheEntry>();

/**
 * Check whether `userId` is a member of `chatId`, fail-open on any API error
 * (bot not an admin of that chat, chat deleted, network blip, …) so a
 * misconfigured/kicked-bot scenario never locks out every customer.
 */
async function checkMembership(ctx: MyContext, chatId: string, userId: number): Promise<boolean | "error"> {
  try {
    const member = await ctx.api.getChatMember(Number(chatId), userId);
    if (member.status === "creator" || member.status === "administrator" || member.status === "member") return true;
    if (member.status === "restricted") return member.is_member;
    return false; // "left" | "kicked"
  } catch (err) {
    logger.warn({ err, chatId }, `getChatMember failed for join-gate chat ${chatId} — failing open for this update so a misconfigured/kicked-bot scenario never locks out every customer`);
    return "error";
  }
}

/**
 * Block every customer interaction until the admin-configured join-gate
 * channel/group (Setting keys `join_gate_channel_id`/`join_gate_group_id`)
 * have been joined. Admins always pass through untouched; the feature is a
 * no-op (zero getChatMember calls) when neither setting is configured.
 *
 * The "✅ I've Joined" button reuses the existing main-menu callback data
 * (`ckb.cb("menu", "main")`) instead of a new callback domain: when a fresh
 * check now passes, this middleware calls `next()` so the SAME tap falls
 * through to the existing menu router and renders the main menu with no
 * extra plumbing. That same tap is also the one path that always forces a
 * fresh (uncached) check, so a customer who just joined never gets stuck on
 * a stale cached verdict.
 *
 * `my_chat_member` status-change events pass straight through (nothing to
 * gate). Once the gate is actually configured, a non-admin's update from a
 * non-private chat is silently swallowed rather than replied to — the bot
 * must be an admin of the required group to check membership there, so
 * replying into it would spam that group for every member who joined the
 * group but not the channel. That check runs LAST (after the admin
 * exemption and the not-configured no-op), so it never touches an admin's
 * taps in an unrelated group (e.g. replying to a support ticket) and never
 * fires at all for a shop that hasn't configured a join gate.
 */
export const joinGate: MiddlewareFn<MyContext> = async (ctx, next) => {
  const from = ctx.from;
  if (!from) return next();
  if (ctx.myChatMember) return next(); // status-change events aren't a customer interaction to gate
  if (isAdmin(from.id)) return next();

  const [channelId, groupId] = await Promise.all([
    getSetting(prisma, "join_gate_channel_id"),
    getSetting(prisma, "join_gate_group_id"),
  ]);
  if (!channelId && !groupId) return next();

  // Only reachable once the gate is actually active. Never reply into a
  // group/channel (would spam it); also blocks any group-originated command
  // from bypassing the gate.
  if (ctx.chat?.type !== "private") return;

  const forceFresh = ctx.callbackQuery?.data === ckb.cb("menu", "main");
  const cached = joinGateCache.get(from.id);
  const useCache = !forceFresh && cached !== undefined && Date.now() - cached.checkedAt <= JOIN_GATE_CACHE_TTL_MS;

  let channelOk: boolean, groupOk: boolean;
  if (useCache) {
    ({ channelOk, groupOk } = cached);
  } else {
    const [channelResult, groupResult] = await Promise.all([
      channelId ? checkMembership(ctx, channelId, from.id) : Promise.resolve(true),
      groupId ? checkMembership(ctx, groupId, from.id) : Promise.resolve(true),
    ]);
    channelOk = channelResult === "error" ? true : channelResult;
    groupOk = groupResult === "error" ? true : groupResult;
    joinGateCache.set(from.id, { channelOk, groupOk, checkedAt: Date.now() });
  }

  if (channelOk && groupOk) return next();

  const missingChannel = Boolean(channelId) && !channelOk;
  const missingGroup = Boolean(groupId) && !groupOk;

  if (ctx.callbackQuery) {
    const key = forceFresh ? "gate.alert_still_missing" : "gate.alert_generic";
    await ctx.answerCallbackQuery({ text: t(ctx, key), show_alert: true });
    return;
  }

  const kb = new InlineKeyboard();
  if (missingChannel) {
    const url = await getSetting(prisma, "join_gate_channel_url");
    if (url) kb.url(t(ctx, "gate.btn_join_channel"), url).row();
  }
  if (missingGroup) {
    const url = await getSetting(prisma, "join_gate_group_url");
    if (url) kb.url(t(ctx, "gate.btn_join_group"), url).row();
  }
  kb.text(t(ctx, "gate.btn_check_again"), ckb.cb("menu", "main"));

  const lines = [missingChannel ? t(ctx, "gate.line_channel") : null, missingGroup ? t(ctx, "gate.line_group") : null].filter(
    (line): line is string => line !== null,
  );
  const text = t(ctx, "gate.header") + "\n" + lines.join("\n") + t(ctx, "gate.footer");
  await ctx.reply(text, { reply_markup: kb });
};
