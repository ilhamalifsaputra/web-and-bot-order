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

export async function setLoginCredentials(
  db: Db,
  userId: number,
  args: { loginUsername?: string; email?: string; passwordHash?: string },
) {
  const data: Record<string, string> = {};
  if (args.loginUsername !== undefined) data.loginUsername = args.loginUsername.toLowerCase();
  if (args.email !== undefined) data.email = args.email.toLowerCase();
  if (args.passwordHash !== undefined) data.passwordHash = args.passwordHash;
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
