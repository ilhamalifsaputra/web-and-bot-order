import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { ValidationError } from "@app/core/errors";
import {
  createWebUser,
  findUserByLoginIdentifier,
  setLoginCredentials,
  linkTelegram,
  createPasswordResetToken,
  consumePasswordResetToken,
} from "./webauth";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await prisma.passwordResetToken.deleteMany();
  await prisma.referral.deleteMany();
  await prisma.user.deleteMany();
});

describe("createWebUser", () => {
  it("creates a customer with no telegramId and a referral code", async () => {
    const u = await createWebUser(prisma, {
      loginUsername: "budi_99",
      email: "Budi@Mail.com",
      passwordHash: "$2b$12$hash",
    });
    expect(u.telegramId).toBeNull();
    expect(u.loginUsername).toBe("budi_99");
    expect(u.email).toBe("budi@mail.com"); // stored lowercase
    expect(u.role).toBe("CUSTOMER");
    expect(u.referralCode).toMatch(/\w+/);
  });

  it("attributes a referrer by code, excluding unknown codes", async () => {
    const referrer = await prisma.user.create({
      data: { telegramId: 111n, referralCode: "REFAAA" },
    });
    const u = await createWebUser(prisma, {
      loginUsername: "sari",
      email: "sari@mail.com",
      passwordHash: "x",
      referredByCode: "refaaa",
    });
    expect(u.referredById).toBe(referrer.id);
    const v = await createWebUser(prisma, {
      loginUsername: "tono",
      email: "tono@mail.com",
      passwordHash: "x",
      referredByCode: "NOPE",
    });
    expect(v.referredById).toBeNull();
  });

  it("rejects duplicate loginUsername / email with field-specific errors", async () => {
    await createWebUser(prisma, { loginUsername: "dupe", email: "a@b.c", passwordHash: "x" });
    await expect(
      createWebUser(prisma, { loginUsername: "dupe", email: "z@z.z", passwordHash: "x" }),
    ).rejects.toThrowError(/web.register_username_taken/);
    await expect(
      createWebUser(prisma, { loginUsername: "fresh", email: "a@b.c", passwordHash: "x" }),
    ).rejects.toThrowError(/web.register_email_taken/);
  });
});

describe("findUserByLoginIdentifier", () => {
  it("finds by login username or email, case-insensitively", async () => {
    await createWebUser(prisma, { loginUsername: "casey", email: "casey@mail.com", passwordHash: "x" });
    expect((await findUserByLoginIdentifier(prisma, "CASEY"))?.loginUsername).toBe("casey");
    expect((await findUserByLoginIdentifier(prisma, "Casey@Mail.com"))?.email).toBe("casey@mail.com");
    expect(await findUserByLoginIdentifier(prisma, "nobody")).toBeNull();
  });
});

describe("setLoginCredentials", () => {
  it("updates fields selectively and maps unique violations", async () => {
    const a = await createWebUser(prisma, { loginUsername: "alpha", email: "a@a.a", passwordHash: "x" });
    await createWebUser(prisma, { loginUsername: "beta", email: "b@b.b", passwordHash: "x" });
    await setLoginCredentials(prisma, a.id, { email: "NEW@a.a" });
    expect((await prisma.user.findUnique({ where: { id: a.id } }))!.email).toBe("new@a.a");
    await expect(
      setLoginCredentials(prisma, a.id, { loginUsername: "beta" }),
    ).rejects.toThrowError(/web.register_username_taken/);
  });
});

describe("linkTelegram", () => {
  it("attaches a telegramId and refreshes tg identity fields", async () => {
    const u = await createWebUser(prisma, { loginUsername: "linkme", email: "l@l.l", passwordHash: "x" });
    const res = await linkTelegram(prisma, u.id, 555, "tguser", "Tg Name");
    expect(res.ok).toBe(true);
    const row = await prisma.user.findUnique({ where: { id: u.id } });
    expect(row!.telegramId).toBe(555n);
    expect(row!.username).toBe("tguser");
    expect(row!.fullName).toBe("Tg Name");
  });

  it("refuses a telegramId already on another account", async () => {
    await prisma.user.create({ data: { telegramId: 777n, referralCode: "RC777" } });
    const u = await createWebUser(prisma, { loginUsername: "second", email: "s@s.s", passwordHash: "x" });
    const res = await linkTelegram(prisma, u.id, 777, null, null);
    expect(res).toEqual({ ok: false, reason: "taken" });
    expect((await prisma.user.findUnique({ where: { id: u.id } }))!.telegramId).toBeNull();
  });
});

describe("password reset tokens", () => {
  it("issues a token and consumes it exactly once", async () => {
    const u = await createWebUser(prisma, { loginUsername: "reset", email: "r@r.r", passwordHash: "x" });
    const { token } = await createPasswordResetToken(prisma, u.id);
    expect(token.length).toBeGreaterThanOrEqual(32);
    // raw token is NOT in the DB
    expect(await prisma.passwordResetToken.findFirst({ where: { tokenHash: token } })).toBeNull();
    const hit = await consumePasswordResetToken(prisma, token);
    expect(hit?.id).toBe(u.id);
    expect(await consumePasswordResetToken(prisma, token)).toBeNull(); // single-use
  });

  it("rejects expired and unknown tokens", async () => {
    const u = await createWebUser(prisma, { loginUsername: "exp", email: "e@e.e", passwordHash: "x" });
    const { token } = await createPasswordResetToken(prisma, u.id, -1); // already expired
    expect(await consumePasswordResetToken(prisma, token)).toBeNull();
    expect(await consumePasswordResetToken(prisma, "bogus-token")).toBeNull();
  });
});
