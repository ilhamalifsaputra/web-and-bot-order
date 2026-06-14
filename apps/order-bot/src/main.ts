/**
 * Bot entry point — port of main.py (PTB → grammY).
 *
 * `buildBot()` constructs the Bot and wires every middleware/handler but does
 * NO network or DB I/O, so it is safe to import in tests. `start()` performs
 * the side-effectful boot (initDb, command menu, jobs, polling) and only runs
 * when this module is the process entry point.
 *
 * Middleware order mirrors the PTB handler groups:
 *   bindUpdateId → sequentialize(per-chat) → session → conversations() →
 *   registeredUser → rateLimit → (conversation resumes) → conversation entry
 *   triggers → commands → callback router → product-number message handler.
 *
 * The conversations plugin resumes an active conversation and consumes the
 * update before the entry triggers / router run, so an in-flight conversation
 * keeps control of its input (PTB group-0 ConversationHandler semantics).
 */
import { pathToFileURL } from "node:url";
import { Bot, session } from "grammy";
import { conversations, createConversation } from "@grammyjs/conversations";
import { run, sequentialize } from "@grammyjs/runner";
import { config } from "@app/core/config";
import { botToken, setBotIdentity, adminIds } from "@app/core/runtime";
import { initDb, prisma, resolveBotCredentials } from "@app/db";
import { logger } from "@app/core/logger";
import type { MyContext } from "./context";
import { initialSession } from "./context";
import { bindUpdateId, registeredUser, rateLimit } from "./middleware";
import { CONVERSATIONS } from "./conversations";
import { coreT } from "./util/i18n";
import { newErrorRef } from "./util/errors";
import * as customer from "./handlers/customer";
import * as staticPages from "./handlers/static";
import * as admin from "./handlers/admin";
import { routeCallback } from "./handlers/callbacks";
import { scheduleJobs, scheduleFxRefresh } from "./jobs";
import { startPolling, stopPolling } from "./payments/binanceInternal";
import { startPolling as startBybitPolling, stopPolling as stopBybitPolling } from "./payments/bybitDeposit";

/**
 * Build a fully-wired bot. Pure construction — no network/DB side effects.
 * The token is the caller's (composition root resolves Setting→env, plan.md
 * §16.3); without an argument it falls back to the runtime/env value.
 */
export function buildBot(token?: string): Bot<MyContext> {
  const resolvedToken = token ?? botToken();
  if (!resolvedToken) {
    throw new Error("Bot token is not configured (set it in web-admin Settings or BOT_TOKEN env)");
  }
  const bot = new Bot<MyContext>(resolvedToken);

  // Global send defaults (replaces PTB Defaults(parse_mode=HTML, no link preview)).
  // Add parse_mode HTML only when neither parse_mode nor (caption_)entities is set.
  bot.api.config.use((prev, method, payload, signal) => {
    const p = payload as Record<string, unknown>;
    if (method === "sendMessage" || method === "editMessageText") {
      if (p && !("parse_mode" in p) && !("entities" in p)) p.parse_mode = "HTML";
      if (p && !("link_preview_options" in p)) p.link_preview_options = { is_disabled: true };
    } else if (method === "sendPhoto" || method === "editMessageCaption") {
      if (p && !("parse_mode" in p) && !("caption_entities" in p)) p.parse_mode = "HTML";
    }
    return prev(method, payload as never, signal);
  });

  // --- Middleware chain ----------------------------------------------------
  bot.use(bindUpdateId); // group -2: bind update_id into the logging context
  bot.use(sequentialize((ctx) => String(ctx.chat?.id ?? ctx.from?.id ?? "")));
  bot.use(session({ initial: initialSession }));
  bot.use(conversations());
  bot.use(registeredUser); // upsert user, sync session.lang, block bans
  bot.use(rateLimit);

  // --- Conversations (resume first; consume the update if one is active) ---
  for (const spec of CONVERSATIONS) {
    bot.use(createConversation(spec.fn, spec.name));
  }

  // --- Conversation entry triggers (only fire when no conversation active) -
  for (const spec of CONVERSATIONS) {
    const enter = (ctx: MyContext) => ctx.conversation.enter(spec.name);
    if (spec.callback) bot.callbackQuery(spec.callback, enter);
    if (spec.command) bot.command(spec.command, enter);
    if (spec.hears) bot.hears(spec.hears, enter);
  }

  // --- Commands (PTB group 1) ----------------------------------------------
  bot.command(["start", "menu"], customer.startCommand);
  bot.command("cancel", customer.cancelCommand);
  bot.command("listproduk", customer.listprodukCommand);
  bot.command("language", customer.languageCommand);
  bot.command("search", customer.searchCommand);
  bot.command("faq", staticPages.faqCommand);
  bot.command("terms", staticPages.termsCommand);
  bot.command("howtopay", staticPages.howtopayCommand);
  bot.command("admin", admin.adminCommand);
  bot.command("wallet", admin.adminWalletCommand);

  // --- Callback router + persistent-keyboard number input (PTB group 2) ----
  bot.callbackQuery(/^v1:/, routeCallback);
  // Buttons from pre-migration bubbles (non-v1 data) would otherwise hang the
  // tap spinner forever — answer them with a "screen expired" toast.
  bot.on("callback_query", async (ctx) => {
    logger.warn({ event: "dead_tap", callbackData: ctx.callbackQuery.data, userId: ctx.from?.id }, "stale callback (pre-migration)");
    try {
      await ctx.answerCallbackQuery({ text: coreT("error.stale_screen", ctx.session.lang) });
    } catch {
      /* best-effort */
    }
  });
  bot.on("message:text", async (ctx, next) => {
    if ((ctx.message.text ?? "").startsWith("/")) return next();
    await customer.handleProductNumber(ctx);
  });

  // --- Global error handler ------------------------------------------------
  bot.catch(async (err) => {
    const ctx = err.ctx;
    // Correlation id: shown to the user AND attached to the log line so a
    // customer report ("I got ref AB12CD") maps straight to the stack trace.
    const ref = newErrorRef();
    const bits: string[] = [`ref=${ref}`];
    if (ctx.from) bits.push(`user=${ctx.from.id}`);
    if (ctx.callbackQuery?.data) bits.push(`cb=${ctx.callbackQuery.data}`);
    else if (ctx.message?.text) bits.push(`text=${ctx.message.text.slice(0, 120)}`);
    logger.error({ err: err.error, ref }, `Unhandled error in grammY [${bits.join(" ")}]`);

    // Best-effort: tell the user something broke (with the ref), so an uncaught
    // exception doesn't leave them staring at a dead screen. Never rethrow here.
    try {
      let lang: string = config.DEFAULT_LANGUAGE;
      try {
        lang = (ctx.session as { lang?: string })?.lang ?? lang;
      } catch {
        /* session middleware may not have run for this update */
      }
      const text = coreT("error.generic_ref", lang, { ref });
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text, show_alert: true });
      else if (ctx.chat) await ctx.reply(text);
    } catch {
      /* user is unreachable / already responded — the log line is the record */
    }
  });

  return bot;
}

// --- Command menu (set_my_commands EN/ID + per-admin) ----------------------
export async function setupCommandMenu(bot: Bot<MyContext>): Promise<void> {
  const generalEn = [
    { command: "start", description: "Start bot" },
    { command: "listproduk", description: "View product list" },
    { command: "language", description: "Change language" },
    { command: "search", description: "Search for a product" },
    { command: "faq", description: "Frequently asked questions" },
    { command: "howtopay", description: "How to pay" },
    { command: "terms", description: "Terms of service" },
    { command: "support", description: "Contact support" },
    { command: "cancel", description: "Cancel current operation" },
  ];
  const generalId = [
    { command: "start", description: "Mulai bot" },
    { command: "listproduk", description: "Lihat daftar produk" },
    { command: "language", description: "Ganti bahasa" },
    { command: "search", description: "Cari produk" },
    { command: "faq", description: "Pertanyaan umum" },
    { command: "howtopay", description: "Cara pembayaran" },
    { command: "terms", description: "Ketentuan layanan" },
    { command: "support", description: "Hubungi support" },
    { command: "cancel", description: "Batalkan operasi" },
  ];
  const adminCommands = [
    { command: "start", description: "Open main menu" },
    { command: "admin", description: "Admin panel" },
    { command: "wallet", description: "Adjust user wallet" },
    { command: "cancel", description: "Cancel current operation" },
  ];

  try {
    await bot.api.setMyCommands(generalEn);
    await bot.api.setMyCommands(generalId, { language_code: "id" });
    for (const adminId of adminIds()) {
      try {
        await bot.api.setMyCommands(adminCommands, { scope: { type: "chat", chat_id: adminId } });
      } catch {
        logger.warn(`Could not set admin commands for ${adminId}`);
      }
    }
    logger.info("Bot command menu configured");
  } catch (err) {
    logger.error({ err }, "Failed to configure bot command menu");
  }
}

// --- Startup ---------------------------------------------------------------
export async function start(): Promise<void> {
  await initDb();
  // Setting wins, env is the bootstrap/recovery fallback (plan.md §16.3).
  const creds = await resolveBotCredentials(prisma);
  if (!creds.botToken) {
    logger.error("Bot token is not configured — set it in web-admin Settings or BOT_TOKEN env");
    return;
  }
  setBotIdentity({
    botToken: creds.botToken,
    botUsername: creds.botUsername ?? undefined,
    notifBotToken: creds.notifBotToken ?? undefined,
  });
  const bot = buildBot(creds.botToken);
  // bot_username can stay unset in Settings — getMe fills it (referral links,
  // Telegram Login widget). Best-effort: a blip here must not stop the boot.
  try {
    setBotIdentity({ botUsername: (await bot.api.getMe()).username });
  } catch (err) {
    logger.warn({ err }, "getMe failed; using configured bot_username if any");
  }
  await setupCommandMenu(bot);
  scheduleJobs(bot.api);
  scheduleFxRefresh();
  // drop_pending_updates: discard updates queued during downtime so stale
  // "Buy"/"Approve" taps aren't reprocessed against moved-on state. Best-effort:
  // a transient network blip here must not stop the bot from starting — the
  // runner retries getUpdates and self-heals once connectivity returns.
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
  } catch (err) {
    logger.warn({ err }, "deleteWebhook failed (continuing; pending updates not dropped)");
  }
  logger.info("Bot is starting up");

  const runner = run(bot, {
    runner: {
      fetch: {
        allowed_updates: ["message", "edited_message", "callback_query", "my_chat_member"],
      },
    },
  });

  // Crypto auto-confirmation pollers (each a no-op unless its creds are set).
  startPolling(bot.api); // Binance Internal Transfer
  startBybitPolling(bot.api); // Bybit USDT-BSC deposits

  const stop = async () => {
    logger.info("Shutting down…");
    stopPolling();
    stopBybitPolling();
    if (runner.isRunning()) await runner.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

// Only boot when run directly (not when imported by tests, nor when bundled
// into the combined @app/server entry — esbuild defines APP_BUNDLED there so
// this self-start is suppressed and only apps/server/src/main.ts drives boot).
const isEntry =
  process.env.APP_BUNDLED !== "1" &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  start().catch((err) => {
    logger.error({ err }, "Fatal error during startup");
    process.exit(1);
  });
}
