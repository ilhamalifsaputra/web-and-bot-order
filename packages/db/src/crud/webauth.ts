import { createHash, randomBytes } from "node:crypto";
import { UserRole, Language } from "@app/core/enums";
import { config } from "@app/core/config";
import { generateReferralCode } from "@app/core/formatters";
import { ValidationError } from "@app/core/errors";
import { logger } from "@app/core/logger";
import type { Db } from "./_types";
import { isUniqueViolation } from "./_types";

export const LOGIN_USERNAME_RE = /^[a-z0-9_]{3,32}$/;
export const RESET_TOKEN_TTL_MINUTES = 60;

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

function mapUniqueViolation(e: unknown): "retry" | never {
  const target = String((e as { meta?: { target?: unknown } }).meta?.target ?? "");
  if (target.includes("referral")) return "retry";
  if (target.includes("login_username")) throw new ValidationError("web.register_username_taken");
  if (target.includes("email")) throw new ValidationError("web.register_email_taken");
  throw e;
}

export async function createWebUser(
  db: Db,
  args: {
    loginUsername: string;
    email: string;
    passwordHash: string;
    fullName: string;
    referredByCode?: string | null;
  },
) {
  const loginUsername = args.loginUsername.toLowerCase();
  const email = args.email.toLowerCase();

  let referredById: number | null = null;
  if (args.referredByCode) {
    const referrer = await db.user.findUnique({
      where: { referralCode: args.referredByCode.toUpperCase() },
    });
    if (referrer) referredById = referrer.id;
  }

  const now = new Date();
  for (let i = 0; i < 5; i++) {
    try {
      const user = await db.user.create({
        data: {
          telegramId: null,
          loginUsername,
          email,
          passwordHash: args.passwordHash,
          fullName: args.fullName,
          role: UserRole.CUSTOMER,
          language: config.DEFAULT_LANGUAGE.toUpperCase() as Language,
          referralCode: generateReferralCode(),
          referredById,
          createdAt: now,
          lastSeenAt: now,
        },
      });
      logger.info(`Registered new web user ${user.id}`);
      return user;
    } catch (e) {
      if (isUniqueViolation(e) && mapUniqueViolation(e) === "retry") continue;
      throw e;
    }
  }
  throw new Error("Could not generate a unique referral code");
}

/**
 * Creates a synthetic guest-checkout user row: no telegramId, loginUsername,
 * email, or passwordHash, just a contact `guestEmail` for the order. Order
 * requires a non-null `userId`, so guest checkout (no login) attaches the
 * order to one of these rows instead. Mirrors createWebUser's referral-code
 * retry loop and unique-violation handling; `guestEmail` is intentionally
 * NOT unique (see the schema doc comment), so unlike createWebUser this can
 * never hit an email-based unique violation — only a referralCode collision
 * can trigger a retry here.
 */
export async function createGuestUser(db: Db, args: { email: string }) {
  const guestEmail = args.email.trim().toLowerCase();

  const now = new Date();
  for (let i = 0; i < 5; i++) {
    try {
      const user = await db.user.create({
        data: {
          telegramId: null,
          loginUsername: null,
          email: null,
          passwordHash: null,
          fullName: null,
          role: UserRole.CUSTOMER,
          language: config.DEFAULT_LANGUAGE.toUpperCase() as Language,
          referralCode: generateReferralCode(),
          isGuest: true,
          guestEmail,
          createdAt: now,
          lastSeenAt: now,
        },
      });
      logger.info(`Registered new guest user ${user.id}`);
      return user;
    } catch (e) {
      if (isUniqueViolation(e) && mapUniqueViolation(e) === "retry") continue;
      throw e;
    }
  }
  throw new Error("Could not generate a unique referral code");
}

/**
 * Full user row INCLUDING `passwordHash` (and `email`) — for the storefront's
 * own-account session load (`apps/storefront/src/plugins/auth.ts`'s
 * `optionalCustomer`), which needs `passwordHash` to answer "does this
 * account have a password" and to verify `current_password` on a credentials
 * change (apps/storefront/src/routes/apiAccount.ts), and `email` to render
 * the account's own settings form. This is the one narrowly-scoped exception
 * to crud/users.ts's `getUser`, which projects both fields out for every
 * admin-and-bot-facing caller (backend audit finding H-4) — a user reading
 * their OWN passwordHash/email server-side to manage their OWN account is not
 * the leak that finding is about. NEVER use this for admin-facing JSON
 * responses, and never send `passwordHash` itself back to any client.
 */
export function getUserWithPasswordHash(db: Db, userId: number) {
  return db.user.findUnique({ where: { id: userId } });
}

export function findUserByLoginIdentifier(db: Db, identifier: string) {
  const ident = identifier.trim().toLowerCase();
  if (!ident) return Promise.resolve(null);
  return db.user.findFirst({
    where: { OR: [{ loginUsername: ident }, { email: ident }] },
  });
}

/**
 * Set a user's login identity fields. Also the one place a guest row stops
 * being a guest row.
 *
 * **Security — the guest-marker clearing is load-bearing.** `POST
 * /api/v1/track` mints a full session from (order code + `guestEmail`) with no
 * password involved, gated only on `isGuest`. That trade is only acceptable
 * while the account has no password to bypass: a guest's contact address IS
 * their whole identity. The moment a password exists, the same shortcut would
 * let anyone holding the order code and the old contact address walk past that
 * password AND rotate the real owner's session out (establishSession rotates
 * the jti).
 *
 * Both routes that can give an account its first password land here — the
 * storefront's `POST /api/v1/account/settings/credentials` (which skips the
 * current-password re-auth precisely because `passwordHash` is still null) and
 * `POST /api/v1/auth/reset` — so clearing the markers here closes the gap for
 * both at once rather than in each caller.
 *
 * Keyed on `passwordHash`, not on any credential change: a guest who fills in
 * only a username or email still cannot sign in (login requires a
 * `passwordHash`), so `/track` remains their only route back to their own
 * order and clearing `isGuest` there would lock them out for nothing.
 *
 * `guestEmail` is nulled alongside `isGuest` rather than kept: once `isGuest`
 * is false every reader of the field (channelMaskedBuyerId, customerLabel, the
 * admin order pages) already ignores it, so leaving it would only preserve a
 * stale contact address that the admin order search can still match — an
 * address the buyer has, by upgrading, replaced with `User.email`.
 */
export async function setLoginCredentials(
  db: Db,
  userId: number,
  args: { loginUsername?: string; email?: string; passwordHash?: string },
) {
  const data: Record<string, string | boolean | null> = {};
  if (args.loginUsername !== undefined) data.loginUsername = args.loginUsername.toLowerCase();
  if (args.email !== undefined) data.email = args.email.toLowerCase();
  if (args.passwordHash !== undefined) {
    data.passwordHash = args.passwordHash;
    // Idempotent for an account that was never a guest: both fields already
    // hold exactly these values there.
    data.isGuest = false;
    data.guestEmail = null;
  }
  if (Object.keys(data).length === 0) return;
  try {
    await db.user.update({ where: { id: userId }, data });
  } catch (e) {
    if (isUniqueViolation(e)) mapUniqueViolation(e);
    throw e;
  }
}

export async function linkTelegram(
  db: Db,
  userId: number,
  telegramId: number | bigint,
  tgUsername: string | null,
  fullName: string | null,
): Promise<{ ok: true } | { ok: false; reason: "taken" }> {
  const tid = BigInt(telegramId);
  const holder = await db.user.findUnique({ where: { telegramId: tid } });
  if (holder && holder.id !== userId) return { ok: false, reason: "taken" };
  try {
    await db.user.update({
      where: { id: userId },
      data: { telegramId: tid, username: tgUsername, fullName },
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, reason: "taken" };
    throw e;
  }
  return { ok: true };
}

export async function createPasswordResetToken(
  db: Db,
  userId: number,
  ttlMinutes = RESET_TOKEN_TTL_MINUTES,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
  await db.passwordResetToken.create({
    data: { userId, tokenHash: sha256hex(token), expiresAt },
  });
  return { token, expiresAt };
}

export async function consumePasswordResetToken(db: Db, token: string) {
  const now = new Date();
  const hash = sha256hex(token);
  // Atomic: only one concurrent request can win the update (usedAt: null guard).
  const { count } = await db.passwordResetToken.updateMany({
    where: { tokenHash: hash, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  if (count === 0) return null;
  // Fetch the user only after we've atomically claimed the token.
  const row = await db.passwordResetToken.findUnique({
    where: { tokenHash: hash },
    include: { user: true },
  });
  return row?.user ?? null;
}
