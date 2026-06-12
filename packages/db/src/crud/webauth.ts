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
          role: UserRole.CUSTOMER,
          language: config.DEFAULT_LANGUAGE.toUpperCase() as Language,
          referralCode: generateReferralCode(),
          referredById,
          createdAt: now,
          lastSeenAt: now,
        },
      });
      logger.info(`Registered new web user id=${user.id}`);
      return user;
    } catch (e) {
      if (isUniqueViolation(e) && mapUniqueViolation(e) === "retry") continue;
      throw e;
    }
  }
  throw new Error("Could not generate a unique referral code");
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
  await db.user.update({
    where: { id: userId },
    data: { telegramId: tid, username: tgUsername, fullName },
  });
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
  const row = await db.passwordResetToken.findUnique({
    where: { tokenHash: sha256hex(token) },
    include: { user: true },
  });
  if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) return null;
  await db.passwordResetToken.update({
    where: { id: row.id },
    data: { usedAt: new Date() },
  });
  return row.user;
}
