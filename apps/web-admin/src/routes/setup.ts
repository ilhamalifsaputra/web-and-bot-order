/**
 * Setup wizard (spec §4) — first-run onboarding entirely in the browser.
 * Pre-auth (no session yet), so like /bootstrap these POSTs carry no CSRF token;
 * the bind-127.0.0.1 + short setup window + permanent lock (spec §8) are the
 * mitigations. /setup* is excluded from the setup gate (see plugins/setupGate),
 * and locks itself once `setup_completed` is set (final step only).
 *
 * Takeover hardening: step 2 only accepts a Telegram ID that is in the
 * ADMIN_IDS allow-list (same rule as /bootstrap), every pre-auth wizard POST
 * is rate limited per IP, and step 2 hands the browser that completed it a
 * random nonce cookie (only its hash is stored). The finish step (/setup/shop)
 * refuses to mint the owner session unless that cookie matches, so a third
 * party who reaches /setup/shop inside the window cannot take the session.
 *
 * M-30: an abandoned wizard (browser closed, deploy interrupted) between step
 * 2 and step 3 must not hold the pre-auth, no-CSRF POST /setup/owner open
 * forever. OWNER_TG_KEY is timestamped when step 2 sets it and treated as
 * expired after OWNER_SETUP_WINDOW_MS (see checkSetupLock / isOwnerKeyFresh
 * below) — once expired, checkSetupLock falls back to the anyAdminPasswordSet
 * self-heal, which is already true (step 2 already hashed the owner's
 * password), so the very next request locks the wizard for good.
 *
 * The timestamp is written ONLY on the first successful step 2 of a wizard
 * session — a later re-POST to /setup/owner (legitimate retry: mistyped
 * telegram_id/password) replaces the pending owner in place instead of
 * minting a second admin, and does NOT rewrite OWNER_TG_SET_AT_KEY. Without
 * that, every re-POST would reset the clock, so polling /setup/owner faster
 * than the window kept it "fresh" forever — the same "open forever" hole
 * M-30 exists to close, just requiring repeated hits instead of one.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { logger } from "@app/core/logger";
import { config } from "@app/core/config";
import { addAdminId, removeAdminId, setAdminIds } from "@app/core/runtime";
import {
  prisma,
  getSetting,
  setSetting,
  deleteSetting,
  invalidateSettingCache,
  getUserByTelegramId,
  addAdminIdToDb,
  removeAdminIdFromDb,
  upsertUser,
  isSetupCompleted,
  anyAdminPasswordSet,
  markSetupComplete,
  logAdminAction,
  resolveAdminIds,
} from "@app/db";
import { constantTimeEqual, hashPassword, makeSession, newJti, passwordHashKey, sessionJtiKey, setupRateLimited } from "../auth";
import { setTokenValidator, getTokenValidator } from "../lib/telegramCheck";
import { csrfProtect } from "../plugins/auth";

// Re-exported for tests that import setTokenValidator from this module.
export { setTokenValidator };

export const OWNER_TG_KEY = "setup_owner_tg"; // carries the owner id from step 2 → finish
// Paired with OWNER_TG_KEY: the Date.now() (ms) at which step 2 wrote it, so
// checkSetupLock can tell a fresh mid-wizard state from an abandoned one (M-30).
const OWNER_TG_SET_AT_KEY = "setup_owner_tg_at";
// Hash of the nonce cookie issued to the browser that completed step 2.
const OWNER_NONCE_HASH_KEY = "setup_owner_nonce_hash";
export const SETUP_NONCE_COOKIE = "setup_owner_nonce";
const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");
const OWNER_SETUP_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Once setup is locked, the wizard is gone — send to the normal login.
 * Mirrors setupNeeded()'s OR (isSetupCompleted || anyAdminPasswordSet), so a
 * deploy that was bootstrapped via /bootstrap instead of the wizard (which
 * never set setup_completed) doesn't leave these pre-auth, no-CSRF POSTs open
 * forever. Self-heals setup_completed once an admin password is detected —
 * EXCEPT mid-wizard between step 2 and step 3/finish, where OWNER_TG_KEY is
 * set (step 2 already created the owner's password) but the wizard hasn't
 * reached /setup/shop yet; bootstrap never sets OWNER_TG_KEY, so its presence
 * reliably tells the two cases apart.
 *
 * Returns a plain boolean, NOT `reply` — Fastify's Reply implements `.then`,
 * so a nested async helper that `return reply`s gets unwrapped by native
 * Promise resolution (thenable-chaining) into `undefined` at the `await`
 * call site, silently defeating `if (await lockedRedirect(reply)) return;`.
 * That bug pre-dated this fix and meant the lock never actually blocked
 * POST bodies from running (only the already-sent redirect masked it).
 *
 * Exported so setupShell.ts can reuse the same check for GET routes.
 */
export async function checkSetupLock(reply: FastifyReply): Promise<boolean> {
  if (await isSetupCompleted(prisma)) {
    reply.code(303).redirect("/login");
    return true;
  }
  const midWizard = await isOwnerKeyFresh();
  if (!midWizard && (await anyAdminPasswordSet(prisma))) {
    await markSetupComplete(prisma);
    reply.code(303).redirect("/login");
    return true;
  }
  return false;
}

/**
 * True only while OWNER_TG_KEY is present AND was written within the last
 * OWNER_SETUP_WINDOW_MS (M-30). A stale OWNER_TG_KEY (older than the window,
 * or missing its timestamp entirely — e.g. a pre-fix deploy caught mid-wizard)
 * is treated as absent, so checkSetupLock falls through to the
 * anyAdminPasswordSet self-heal instead of trusting it forever.
 */
async function isOwnerKeyFresh(): Promise<boolean> {
  const ownerTg = await getSetting(prisma, OWNER_TG_KEY);
  if (ownerTg === null) return false;
  const setAt = Number(await getSetting(prisma, OWNER_TG_SET_AT_KEY));
  if (!Number.isFinite(setAt)) return false;
  const elapsedMs = Date.now() - setAt;
  // A negative elapsed time (future/skewed timestamp — restored backup, clock
  // correction, hand-edited Setting row) must fail CLOSED like the malformed
  // cases above, not open: without this check it would trivially satisfy
  // `< OWNER_SETUP_WINDOW_MS` (any negative number is less than a positive
  // one) and read as "fresh" for as long as the clock stays skewed.
  if (elapsedMs < 0) return false;
  return elapsedMs < OWNER_SETUP_WINDOW_MS;
}

export default async function setupRoutes(app: FastifyInstance): Promise<void> {
  // ---- Step 1: connect bot ----
  app.post("/setup/bot", async (req, reply) => {
    const isJson = (req.headers["content-type"] ?? "").includes("application/json");
    if (setupRateLimited(req.ip || "unknown")) {
      return reply.code(429).send({ error: "Too many attempts. Try again later." });
    }
    if (await checkSetupLock(reply)) {
      if (isJson) return reply.code(403).send({ error: "Setup already complete.", redirect: "/login" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, string>;
    if (body.skip) {
      if (isJson) return reply.send({ ok: true, redirect: "/setup/owner" });
      return reply.code(303).redirect("/setup/owner");
    }

    const token = (body.bot_token ?? "").trim();
    if (!token) {
      return reply.code(400).send({ error: "Tempel token bot dari BotFather, atau pilih 'Atur nanti'." });
    }
    const check = await getTokenValidator()(token);
    if (!check.ok) {
      return reply.code(400).send({ error: "Token salah atau bot tidak ditemukan. Cek lagi dari BotFather." });
    }
    await setSetting(prisma, "bot_token", token);
    if (check.username) await setSetting(prisma, "bot_username", check.username);
    logger.info("Setup wizard: bot token verified and saved"); // never log the token
    if (isJson) return reply.send({ ok: true, redirect: "/setup/owner" });
    return reply.code(303).redirect("/setup/owner");
  });

  // ---- Step 2: create owner (admin) ----
  app.post("/setup/owner", async (req, reply) => {
    const isJson = (req.headers["content-type"] ?? "").includes("application/json");
    if (setupRateLimited(req.ip || "unknown")) {
      return reply.code(429).send({ error: "Too many attempts. Try again later." });
    }
    if (await checkSetupLock(reply)) {
      if (isJson) return reply.code(403).send({ error: "Setup already complete.", redirect: "/login" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, string>;
    const telegramId = Number(body.telegram_id);
    const username = (body.username ?? "").trim() || null;
    const password = body.password ?? "";
    const passwordConfirm = body.password_confirm ?? "";

    let error: string | null = null;
    if (!Number.isInteger(telegramId) || telegramId <= 0) {
      error = "Telegram ID harus berupa angka. Dapatkan dari @userinfobot.";
    } else if (!config.ADMIN_IDS.includes(telegramId)) {
      // Same allow-list as POST /bootstrap: this route is pre-auth, so without
      // it whoever reaches the wizard first could make themselves the owner.
      error = "Telegram ID ini belum ada di daftar ADMIN_IDS bot. Tambahkan ID Telegram-mu ke ADMIN_IDS di file .env lalu mulai ulang server.";
    } else if (password.length < 8) {
      error = "Password minimal 8 karakter.";
    } else if (password !== passwordConfirm) {
      error = "Konfirmasi password tidak cocok.";
    }
    if (error) {
      return reply.code(400).send({ error });
    }

    // Re-entry within the same wizard session (M-30): checkSetupLock above
    // already proved that IF OWNER_TG_KEY is present, it's still fresh — so a
    // present value here is the operator redoing step 2 (mistyped ID or
    // password), not a brand-new attacker session. Replace the pending owner
    // in place instead of minting a second admin, and (below) never rewrite
    // OWNER_TG_SET_AT_KEY on a re-POST, so repeated calls can't slide the
    // 30-minute window forward.
    //
    // A retry with a DIFFERENT id always retracts the password this wizard run
    // wrote for the previous id (OWNER_TG_KEY is only set after that write,
    // and checkSetupLock locks the wizard if any admin already had a password
    // before it started, so that hash is the wizard's own). The previous id's
    // admin STATUS is retracted only when the wizard granted it: env-configured
    // admins (config.ADMIN_IDS) are never demoted here — same rule
    // ../routes/api/admins.ts enforces for its own remove endpoint.
    const previousOwnerRaw = await getSetting(prisma, OWNER_TG_KEY);
    const previousOwnerTg = previousOwnerRaw !== null ? Number(previousOwnerRaw) : null;
    const isFirstAttempt = previousOwnerTg === null;
    const shouldRetractPreviousCredential = previousOwnerTg !== null && previousOwnerTg !== telegramId;
    const shouldReplacePrevious = shouldRetractPreviousCredential && !config.ADMIN_IDS.includes(previousOwnerTg!);

    // Make the id an admin in the runtime FIRST so upsertUser resolves role=ADMIN,
    // then persist everything in one short transaction.
    addAdminId(telegramId); // runtime first so upsertUser resolves role=ADMIN
    try {
      await prisma.$transaction(async (tx) => {
        if (shouldRetractPreviousCredential) {
          // The mistyped id must not keep a login the operator never meant to
          // create, even when it stays an (env) admin.
          await deleteSetting(tx, passwordHashKey(previousOwnerTg!));
        }
        if (shouldReplacePrevious) {
          // Retract the previous attempt's admin grant so a corrected retry
          // (different Telegram ID) doesn't leave a second admin behind.
          await removeAdminIdFromDb(tx, previousOwnerTg!);
        }
        await addAdminIdToDb(tx, telegramId);
        await upsertUser(tx, { telegramId, username, fullName: null });
        await setSetting(tx, passwordHashKey(telegramId), hashPassword(password));
      });
    } catch (err) {
      // Transaction failed — undo the in-memory promotion so isAdmin() stays
      // consistent with the DB (re-derive the canonical env ∪ DB list).
      setAdminIds(await resolveAdminIds(prisma));
      throw err;
    }
    // The delete ran on the transaction's client; drop the request client's
    // cached copy too, so a login straight after cannot read the old hash.
    if (shouldRetractPreviousCredential) invalidateSettingCache(prisma, [passwordHashKey(previousOwnerTg!)]);
    if (shouldReplacePrevious) removeAdminId(previousOwnerTg!);
    await setSetting(prisma, OWNER_TG_KEY, String(telegramId));
    if (isFirstAttempt) {
      // Starts the M-30 expiry window — ONLY on the first successful step 2
      // of this wizard session. A later retry (above) must not reach this,
      // or every re-POST would extend the window indefinitely.
      await setSetting(prisma, OWNER_TG_SET_AT_KEY, String(Date.now()));
    }
    // Bind the finish step to THIS browser (a retry replaces the nonce).
    const nonce = randomBytes(24).toString("base64url");
    await setSetting(prisma, OWNER_NONCE_HASH_KEY, sha256Hex(nonce));
    reply.setCookie(SETUP_NONCE_COOKIE, nonce, {
      path: "/",
      maxAge: OWNER_SETUP_WINDOW_MS / 1000,
      httpOnly: true,
      sameSite: "lax",
      secure: config.WEB_COOKIE_SECURE,
    });
    logger.info(`Setup wizard: created owner admin with Telegram id ${telegramId}`); // never log the password
    if (isJson) return reply.send({ ok: true, redirect: "/setup/shop" });
    return reply.code(303).redirect("/setup/shop");
  });

  // ---- Step 3: shop basics (skippable) + finish ----
  app.post("/setup/shop", async (req, reply) => {
    const isJson = (req.headers["content-type"] ?? "").includes("application/json");
    if (setupRateLimited(req.ip || "unknown")) {
      return reply.code(429).send({ error: "Too many attempts. Try again later." });
    }
    if (await checkSetupLock(reply)) {
      if (isJson) return reply.code(403).send({ error: "Setup already complete.", redirect: "/login" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, string>;

    // The owner must exist (step 2) before we can finish + auto-login.
    const ownerTg = Number(await getSetting(prisma, OWNER_TG_KEY));
    if (!Number.isInteger(ownerTg) || ownerTg <= 0) {
      return reply.code(303).redirect("/setup/owner");
    }

    // Only the browser that completed step 2 may finish and receive the owner
    // session: it must present the nonce cookie issued there.
    const storedNonceHash = await getSetting(prisma, OWNER_NONCE_HASH_KEY);
    const presented = req.cookies?.[SETUP_NONCE_COOKIE];
    if (!storedNonceHash || !presented || !constantTimeEqual(sha256Hex(presented), storedNonceHash)) {
      logger.warn("Setup wizard finish was refused because the request did not carry the owner nonce cookie issued at the owner step. No session was issued.");
      return reply.code(403).send({ error: "Langkah ini hanya bisa diselesaikan dari browser yang membuat akun pemilik. Ulangi langkah pemilik." });
    }

    if (body.skip !== "1") {
      const shopName = (body.shop_name ?? "").trim();
      const tagline = (body.shop_tagline ?? "").trim();
      if (shopName) await setSetting(prisma, "shop_name", shopName);
      if (tagline) await setSetting(prisma, "shop_tagline", tagline);
    }

    // Finish: lock the wizard, then auto-login the owner (rotate jti).
    await markSetupComplete(prisma);
    const owner = await getUserByTelegramId(prisma, ownerTg);
    if (owner) {
      const jti = newJti();
      await setSetting(prisma, sessionJtiKey(ownerTg), jti);
      const { raw } = makeSession(owner.id, ownerTg, jti);
      reply.setCookie(config.WEB_COOKIE_NAME, raw, {
        path: "/",
        maxAge: config.WEB_SESSION_TTL_HOURS * 3600,
        httpOnly: true,
        sameSite: "lax",
        secure: config.WEB_COOKIE_SECURE,
      });
      await logAdminAction(prisma, {
        adminId: owner.id,
        action: "web_setup_completed",
        targetType: "web_admin",
        targetId: null,
        details: `Completed setup wizard for owner (Telegram id ${ownerTg}).`,
      });
    } else {
      logger.error(`Setup wizard finish: no user row found for owner Telegram id ${ownerTg} — skipping auto-login, owner will need to log in manually`);
    }
    await deleteSetting(prisma, OWNER_TG_KEY);
    await deleteSetting(prisma, OWNER_TG_SET_AT_KEY);
    await deleteSetting(prisma, OWNER_NONCE_HASH_KEY);
    reply.clearCookie(SETUP_NONCE_COOKIE, { path: "/" });
    logger.info(`Setup wizard completed — owner with Telegram id ${ownerTg} auto-logged-in`);
    if (isJson) return reply.send({ ok: true, redirect: "/setup/done" });
    return reply.code(303).redirect("/setup/done");
  });

  // ---- Done screen: GET handler moved to setupShell.ts (SPA) ----

  // Best-effort Passenger restart: touch tmp/restart.txt so the app reboots and
  // picks up the new bot token/admin (grammY can't hot-swap a token — spec §7).
  // Unlike its three siblings, this route is only ever called from the Done
  // screen — i.e. AFTER /setup/shop's finish handler has already called
  // markSetupComplete() and auto-logged the owner in (setup.ts above), so a
  // `checkSetupLock` guard would 303-redirect every real call before it ever
  // runs. Gate on a real admin session instead (H-5): an anonymous caller can
  // no longer loop this to reboot the process, while the legitimate
  // post-setup "Restart server" click (which always carries a valid session
  // cookie by the time it fires) keeps working.
  //
  // Same guard as its post-setup twin `/api/settings/restart` (backend audit
  // Task C3): csrfProtect (session + CSRF token + role gate) and owner-only,
  // with an audit line. Previously any logged-in admin — support or readonly
  // included — could reboot the process, from any site, unaudited. The Done
  // screen's shell now carries the owner's CSRF token (setupShell.ts) and the
  // SPA sends it back (SetupDonePage.tsx).
  app.post("/setup/restart", { preHandler: csrfProtect }, async (req, reply) => {
    if (req.admin!.role !== "super") return reply.code(403).send({ error: "Only the owner can restart the bot." });
    const target = process.env.RESTART_TRIGGER_FILE ?? join(process.cwd(), "tmp", "restart.txt");
    let ok = true;
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, new Date().toISOString());
      logger.info("Setup wizard: wrote Passenger restart trigger file to reboot the app");
    } catch (err) {
      ok = false;
      logger.warn({ err }, "Setup wizard: failed to write Passenger restart trigger file — app needs a manual restart from the hosting panel");
    }
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "bot_restart",
      targetType: "setting",
      details: ok
        ? "Restarted the app from the setup wizard to apply the new bot token and owner."
        : "Tried to restart the app from the setup wizard, but it could not be restarted automatically. Restart it from the hosting panel.",
    });
    const botConfigured = (await getSetting(prisma, "bot_token")) !== null;
    return reply.send({ ok: true, restarted: ok, bot_configured: botConfigured });
  });
}
