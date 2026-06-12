# Storefront Username+Password Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add username+password login (with web registration, email forgot-password, and Telegram account linking) to `apps/storefront`, per the approved spec `docs/superpowers/specs/2026-06-12-storefront-password-auth-design.md`.

**Architecture:** `users.telegram_id` becomes nullable; new nullable columns `login_username`/`email`/`password_hash` plus a `password_reset_tokens` table. Sessions are re-keyed by `userId` (not telegramId). The Telegram Login Widget stops auto-creating accounts (lookup-only); a settings page lets members link Telegram. Email goes out via nodemailer behind new `SMTP_*` config. Customer Telegram notifications are skipped for users without a telegramId; the public testimonial post gets a "via Website" marker for them.

**Tech Stack:** Fastify 5, Prisma (SQLite), Nunjucks, bcryptjs, nodemailer, Vitest. Monorepo root: `BOT dan Web Admin/`. All commands run from that root.

**Conventions that apply (CLAUDE.md):** no raw SQL in routes (crud helpers + tests), never log secrets, never send Telegram from the web (outbox), locale key sets in `packages/core/locales/{en,id}.json` must stay identical, `pnpm -r typecheck` + `pnpm test` green.

---

### Task 1: Prisma schema — nullable telegramId, login columns, reset-token table

**Files:**
- Modify: `prisma/schema.prisma` (User model lines 21–52; new model after `WalletTransaction`)

- [ ] **Step 1: Edit the User model**

In `prisma/schema.prisma` change the `telegramId` line and add three columns + one relation. The User model header becomes:

```prisma
model User {
  id            Int       @id @default(autoincrement())
  telegramId    BigInt?   @unique(map: "ix_users_telegram_id") @map("telegram_id")
  username      String?
  fullName      String?   @map("full_name")
  /// Web-store login handle (3-32 chars [a-z0-9_], stored lowercase).
  /// Distinct from `username` (= Telegram username, bot-owned).
  loginUsername String?   @unique(map: "ix_users_login_username") @map("login_username")
  email         String?   @unique(map: "ix_users_email")
  passwordHash  String?   @map("password_hash")
  role          String    @default("CUSTOMER")
```

(the rest of the model is unchanged — keep every existing line). Add to the User relation list (next to `walletTransactions   WalletTransaction[]`):

```prisma
  passwordResetTokens PasswordResetToken[]
```

- [ ] **Step 2: Add the PasswordResetToken model**

Insert after the `WalletTransaction` model:

```prisma
/// Forgot-password tokens for the storefront. Only the SHA-256 hex of the
/// token is stored; rows are single-use (used_at) and expire after 1 hour.
model PasswordResetToken {
  id        Int       @id @default(autoincrement())
  userId    Int       @map("user_id")
  tokenHash String    @unique(map: "ix_password_reset_tokens_hash") @map("token_hash")
  expiresAt DateTime  @map("expires_at")
  usedAt    DateTime? @map("used_at")
  createdAt DateTime  @default(now()) @map("created_at")

  user User @relation(fields: [userId], references: [id], onDelete: Cascade, onUpdate: NoAction)

  @@index([userId], map: "ix_password_reset_tokens_user_id")
  @@map("password_reset_tokens")
}
```

- [ ] **Step 3: Regenerate the client and push to the dev DB**

Run: `pnpm exec prisma generate` then `pnpm exec prisma db push`
Expected: both succeed; db push reports the new columns/table (additive — no data loss prompt).

- [ ] **Step 4: Typecheck the whole repo**

Run: `pnpm -r typecheck`
Expected: PASS. (`Number(x)`/`String(x)` accept `bigint | null`, and nothing assigns null yet. If anything fails, fix the flagged line with an explicit null guard before continuing.)

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(db): nullable telegram_id + login_username/email/password_hash + password_reset_tokens"
```

---

### Task 2: Shared password helpers in @app/core

**Files:**
- Create: `packages/core/src/password.ts`
- Create: `packages/core/src/password.test.ts`
- Modify: `packages/core/package.json` (deps + exports)

- [ ] **Step 1: Add bcryptjs to packages/core**

Run: `pnpm --filter @app/core add bcryptjs && pnpm --filter @app/core add -D @types/bcryptjs`
Expected: lockfile updated. Then check `packages/core/package.json` `exports` field: it maps subpaths like `"./config": "./src/config.ts"` — add `"./password": "./src/password.ts"` following the same pattern (and `"./mailer": "./src/mailer.ts"` now too, used in Task 4).

- [ ] **Step 2: Write the failing test**

`packages/core/src/password.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";

describe("password hashing", () => {
  it("verifies a correct password against its hash", () => {
    const h = hashPassword("s3cret-pass");
    expect(h).toMatch(/^\$2[aby]\$/);
    expect(verifyPassword("s3cret-pass", h)).toBe(true);
  });
  it("rejects a wrong password and garbage hashes without throwing", () => {
    const h = hashPassword("s3cret-pass");
    expect(verifyPassword("wrong", h)).toBe(false);
    expect(verifyPassword("anything", "not-a-bcrypt-hash")).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @app/core test -- password`
Expected: FAIL — Cannot find module './password'.

- [ ] **Step 4: Implement**

`packages/core/src/password.ts` (same construction as `apps/web-admin/src/auth.ts:33-43`, hash-compatible, rounds=12):

```ts
/**
 * Customer password hashing (storefront). bcryptjs (pure JS — buildless on
 * Windows), rounds=12, same parameters as the web-admin's admin passwords.
 */
import bcrypt from "bcryptjs";

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, bcrypt.genSaltSync(12));
}

export function verifyPassword(plain: string, hashed: string): boolean {
  try {
    return bcrypt.compareSync(plain, hashed);
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Run the test again**

Run: `pnpm --filter @app/core test -- password`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/password.ts packages/core/src/password.test.ts packages/core/package.json pnpm-lock.yaml
git commit -m "feat(core): shared bcrypt password helpers for the storefront"
```

---

### Task 3: webauth CRUD — web user creation, lookup, credentials, linking, reset tokens

**Files:**
- Create: `packages/db/src/crud/webauth.ts`
- Create: `packages/db/src/crud/webauth.test.ts`
- Modify: `packages/db/src/index.ts` (add `export * from "./crud/webauth";`)

- [ ] **Step 1: Write the failing tests**

`packages/db/src/crud/webauth.test.ts` (test harness pattern: `packages/db/src/crud/wallet.test.ts`):

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @app/db test -- webauth`
Expected: FAIL — Cannot find module './webauth'.

- [ ] **Step 3: Implement**

`packages/db/src/crud/webauth.ts`:

```ts
/**
 * Web-store auth domain: accounts created on the web (no Telegram), login
 * lookup, credential updates, Telegram linking, and forgot-password tokens.
 * No function commits; the caller controls the transaction. Passwords arrive
 * here ALREADY hashed (@app/core/password) — this layer never sees plaintext.
 */
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

/** Map a P2002 to a field-specific ValidationError; referral collisions retry. */
function mapUniqueViolation(e: unknown): "retry" | never {
  const target = String((e as { meta?: { target?: unknown } }).meta?.target ?? "");
  if (target.includes("referral")) return "retry";
  if (target.includes("login_username")) throw new ValidationError("web.register_username_taken");
  if (target.includes("email")) throw new ValidationError("web.register_email_taken");
  throw e;
}

/** Create a web-registered customer (telegramId = null). Mirrors the create
 * branch of upsertUser: referral attribution + referral-code retry. */
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

/** Login lookup: the identifier is a login username OR an email (both lowercased). */
export function findUserByLoginIdentifier(db: Db, identifier: string) {
  const ident = identifier.trim().toLowerCase();
  if (!ident) return Promise.resolve(null);
  return db.user.findFirst({
    where: { OR: [{ loginUsername: ident }, { email: ident }] },
  });
}

/** Selective update of login_username / email / password_hash. */
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

/** Attach a Telegram identity to an existing account. Refuses a telegramId
 * already used by ANOTHER account (no merging). */
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

/** Issue a forgot-password token: returns the RAW token (for the email link);
 * only its SHA-256 lands in the DB. ttlMinutes overridable for tests. */
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

/** Burn a token: returns its user when valid (unused + unexpired), else null.
 * Marks the row used so the link is single-use. */
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
```

Then add to `packages/db/src/index.ts` after the `credentials` export line:

```ts
export * from "./crud/webauth";
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @app/db test -- webauth`
Expected: PASS (all 9).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/crud/webauth.ts packages/db/src/crud/webauth.test.ts packages/db/src/index.ts
git commit -m "feat(db): webauth crud — web users, login lookup, telegram linking, reset tokens"
```

---

### Task 4: SMTP config + mailer in @app/core

**Files:**
- Modify: `packages/core/src/config.ts` (new env keys after the `notifier` block, ~line 154)
- Create: `packages/core/src/mailer.ts`
- Modify: `packages/core/package.json` (nodemailer dep; `./mailer` export added in Task 2 Step 1)

- [ ] **Step 1: Add nodemailer**

Run: `pnpm --filter @app/core add nodemailer && pnpm --filter @app/core add -D @types/nodemailer`

- [ ] **Step 2: Add the SMTP env keys**

In `packages/core/src/config.ts`, inside the `Env` object after the `// ---- notifier ----` block:

```ts
  // ---- SMTP (storefront forgot-password email) ----
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  // From header, e.g. "Toko Digital <no-reply@example.com>". Required (with
  // SMTP_HOST) for password reset to be offered at all.
  SMTP_FROM: z.string().optional(),
  SMTP_SECURE: looseBool.default(false),
```

And after `isBinanceInternalEnabled` at the bottom:

```ts
/** Password-reset email is offered only when SMTP is fully configured. */
export const isSmtpEnabled = (): boolean => Boolean(config.SMTP_HOST && config.SMTP_FROM);
```

- [ ] **Step 3: Implement the mailer**

`packages/core/src/mailer.ts`:

```ts
/**
 * Outbound email (SMTP via nodemailer) — used by the storefront for
 * forgot-password links. Lazily creates one shared transport. Throws when
 * SMTP is not configured: callers must gate on isSmtpEnabled().
 * NEVER log message bodies (reset links are credentials).
 */
import nodemailer, { type Transporter } from "nodemailer";
import { config, isSmtpEnabled } from "./config";
import { logger } from "./logger";

let transporter: Transporter | null = null;

function transport(): Transporter {
  if (!isSmtpEnabled()) throw new Error("SMTP is not configured");
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
    });
  }
  return transporter;
}

export async function sendMail(args: { to: string; subject: string; text: string }): Promise<void> {
  await transport().sendMail({
    from: config.SMTP_FROM,
    to: args.to,
    subject: args.subject,
    text: args.text,
  });
  logger.info(`Sent mail to=${args.to} subject="${args.subject}"`);
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @app/core typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config.ts packages/core/src/mailer.ts packages/core/package.json pnpm-lock.yaml
git commit -m "feat(core): SMTP config + nodemailer mailer for storefront password reset"
```

---

### Task 5: Locale keys (EN + ID)

**Files:**
- Modify: `packages/core/locales/en.json`
- Modify: `packages/core/locales/id.json`

- [ ] **Step 1: Add/update the keys**

Both files are flat JSON sorted-ish by key — insert near the other `web.*` keys, keeping the two files' key sets identical. **Update** one existing key and **add** the rest.

`en.json` — change:

```json
  "web.login_hint": "Sign in with your username or email — or one tap with Telegram if your account is linked.",
```

`en.json` — add:

```json
  "web.login_or": "or",
  "web.login_identifier": "Username or email",
  "web.login_password": "Password",
  "web.login_submit": "Sign in",
  "web.login_failed": "Wrong username or password.",
  "web.login_tg_unlinked": "This Telegram account isn't registered yet — create an account below, or /start the bot first.",
  "web.login_reset_done": "Password updated — sign in with your new password.",
  "web.register_title": "Create account",
  "web.register_cta": "New here? Create an account",
  "web.register_username": "Username",
  "web.register_username_help": "3–32 characters: lowercase letters, numbers, underscores.",
  "web.register_email": "Email",
  "web.register_password2": "Repeat password",
  "web.register_submit": "Create account",
  "web.register_have_account": "Already have an account? Sign in",
  "web.register_username_invalid": "Username must be 3–32 characters: lowercase letters, numbers, underscores.",
  "web.register_email_invalid": "Enter a valid email address.",
  "web.register_password_short": "Password must be at least 8 characters.",
  "web.register_password_mismatch": "Passwords don't match.",
  "web.register_username_taken": "That username is taken.",
  "web.register_email_taken": "That email is already registered.",
  "web.forgot_title": "Forgot password",
  "web.forgot_link": "Forgot your password?",
  "web.forgot_hint": "Enter your account email — we'll send a reset link.",
  "web.forgot_submit": "Send reset link",
  "web.forgot_sent": "If that email is registered, a reset link is on its way.",
  "web.forgot_unavailable": "Password reset isn't available right now — please contact support.",
  "web.reset_title": "Set a new password",
  "web.reset_submit": "Save new password",
  "web.reset_invalid": "This reset link is invalid or has expired — request a new one.",
  "web.account_settings": "Settings",
  "web.settings_title": "Account settings",
  "web.settings_login_section": "Sign-in details",
  "web.settings_current_password": "Current password",
  "web.settings_new_password": "New password (leave blank to keep)",
  "web.settings_save": "Save",
  "web.settings_saved": "Saved.",
  "web.settings_wrong_password": "Current password is wrong.",
  "web.settings_tg_section": "Telegram",
  "web.settings_tg_linked": "Linked to Telegram as {name}.",
  "web.settings_tg_hint": "Link your Telegram to sign in with one tap and get order updates in the bot.",
  "web.settings_tg_taken": "That Telegram account is already linked to another member.",
  "web.settings_tg_done": "Telegram linked!",
```

`id.json` — change:

```json
  "web.login_hint": "Masuk pakai username atau email — atau sekali tap dengan Telegram jika akunmu sudah tertaut.",
```

`id.json` — add:

```json
  "web.login_or": "atau",
  "web.login_identifier": "Username atau email",
  "web.login_password": "Kata sandi",
  "web.login_submit": "Masuk",
  "web.login_failed": "Username atau kata sandi salah.",
  "web.login_tg_unlinked": "Akun Telegram ini belum terdaftar — buat akun di bawah, atau /start bot dulu.",
  "web.login_reset_done": "Kata sandi diperbarui — masuk dengan kata sandi barumu.",
  "web.register_title": "Buat akun",
  "web.register_cta": "Baru di sini? Buat akun",
  "web.register_username": "Username",
  "web.register_username_help": "3–32 karakter: huruf kecil, angka, garis bawah.",
  "web.register_email": "Email",
  "web.register_password2": "Ulangi kata sandi",
  "web.register_submit": "Buat akun",
  "web.register_have_account": "Sudah punya akun? Masuk",
  "web.register_username_invalid": "Username harus 3–32 karakter: huruf kecil, angka, garis bawah.",
  "web.register_email_invalid": "Masukkan alamat email yang valid.",
  "web.register_password_short": "Kata sandi minimal 8 karakter.",
  "web.register_password_mismatch": "Kata sandi tidak sama.",
  "web.register_username_taken": "Username itu sudah dipakai.",
  "web.register_email_taken": "Email itu sudah terdaftar.",
  "web.forgot_title": "Lupa kata sandi",
  "web.forgot_link": "Lupa kata sandi?",
  "web.forgot_hint": "Masukkan email akunmu — kami kirim tautan reset.",
  "web.forgot_submit": "Kirim tautan reset",
  "web.forgot_sent": "Jika email itu terdaftar, tautan reset sedang dikirim.",
  "web.forgot_unavailable": "Reset kata sandi belum tersedia — silakan hubungi dukungan.",
  "web.reset_title": "Buat kata sandi baru",
  "web.reset_submit": "Simpan kata sandi baru",
  "web.reset_invalid": "Tautan reset ini tidak valid atau kedaluwarsa — minta yang baru.",
  "web.account_settings": "Pengaturan",
  "web.settings_title": "Pengaturan akun",
  "web.settings_login_section": "Detail masuk",
  "web.settings_current_password": "Kata sandi sekarang",
  "web.settings_new_password": "Kata sandi baru (kosongkan jika tetap)",
  "web.settings_save": "Simpan",
  "web.settings_saved": "Tersimpan.",
  "web.settings_wrong_password": "Kata sandi sekarang salah.",
  "web.settings_tg_section": "Telegram",
  "web.settings_tg_linked": "Tertaut ke Telegram sebagai {name}.",
  "web.settings_tg_hint": "Tautkan Telegram-mu untuk masuk sekali tap dan dapat update pesanan di bot.",
  "web.settings_tg_taken": "Akun Telegram itu sudah tertaut ke member lain.",
  "web.settings_tg_done": "Telegram tertaut!",
```

- [ ] **Step 2: Verify key parity**

Run: `pnpm --filter @app/core test -- locales` (the existing locale-parity test; if the filter matches nothing, run `pnpm --filter @app/core test`)
Expected: PASS — en/id key sets identical, placeholders matched.

- [ ] **Step 3: Commit**

```bash
git add packages/core/locales/en.json packages/core/locales/id.json
git commit -m "feat(i18n): storefront password-auth strings (login, register, forgot, settings)"
```

---

### Task 6: Session re-key by userId + reworked /login (password + lookup-only Telegram)

**Files:**
- Modify: `apps/storefront/src/auth.ts`
- Modify: `apps/storefront/src/plugins/auth.ts`
- Modify: `apps/storefront/src/routes/auth.ts`
- Modify: `apps/storefront/views/login.njk`
- Modify: `apps/storefront/test/storefront.test.ts` (add describe blocks)

- [ ] **Step 1: Re-key the session helpers**

In `apps/storefront/src/auth.ts`:

Replace the jti key helper (line 27-28):

```ts
/** jti is keyed per USER (not per telegramId — web-only accounts have none). */
export const shopSessionJtiKey = (userId: number) => `shop_session_jti_user:${userId}`;
```

Change `CustomerSession` and the mint/read pair — `telegramId` becomes nullable and rides along only for display:

```ts
export interface CustomerSession {
  userId: number;
  telegramId: number | null;
  jti: string;
  csrf: string;
}
```

```ts
/** Mint a fresh signed cookie value + its parsed payload. */
export function makeCustomerSession(
  userId: number,
  telegramId: number | bigint | null,
  jti: string,
): { raw: string; data: CustomerSession } {
  const tid = telegramId == null ? null : Number(telegramId);
  const data: CustomerSession = { userId, telegramId: tid, jti, csrf: b64url(randomBytes(24)) };
  const payload = b64url(
    Buffer.from(JSON.stringify({ u: data.userId, t: data.telegramId, j: data.jti, c: data.csrf })),
  );
  const ts = Math.floor(Date.now() / 1000).toString();
  const body = `${payload}.${ts}`;
  return { raw: `${body}.${sign(body)}`, data };
}
```

In `readCustomerSession`, the return object becomes:

```ts
    return {
      userId: Number(obj.u),
      telegramId: obj.t == null ? null : Number(obj.t),
      jti: String(obj.j),
      csrf: String(obj.c),
    };
```

- [ ] **Step 2: Update the guard plugin**

In `apps/storefront/src/plugins/auth.ts`, `optionalCustomer` line 33 changes the jti lookup key:

```ts
  const storedJti = await getSetting(prisma, shopSessionJtiKey(data.userId));
```

- [ ] **Step 3: Rewrite the auth routes**

Replace `apps/storefront/src/routes/auth.ts` entirely:

```ts
/**
 * Customer login/logout/registration-adjacent auth routes.
 *
 * /login now has TWO doors (spec 2026-06-12):
 *   1. username/email + password form (primary)
 *   2. the Telegram Login Widget — LOOKUP-ONLY: it signs in existing accounts
 *      (every bot member qualifies) but no longer auto-creates users; unknown
 *      Telegram IDs are pointed to /register or the bot.
 * Sessions are keyed per userId (web-only accounts have no telegramId).
 * Guest-cart merge on every successful sign-in (plan.md §5 decision D).
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { config } from "@app/core/config";
import { botUsername } from "@app/core/runtime";
import { logger } from "@app/core/logger";
import { t } from "@app/core/i18n";
import { verifyPassword } from "@app/core/password";
import {
  prisma,
  setSetting,
  addToCart,
  getProduct,
  getUserByTelegramId,
  findUserByLoginIdentifier,
} from "@app/db";
import {
  makeCustomerSession,
  newJti,
  shopSessionJtiKey,
  verifyTelegramLogin,
  SHOP_COOKIE_NAME,
  SHOP_SESSION_TTL_HOURS,
} from "../auth";
import { shopContext, readGuestCart, writeGuestCart } from "../shop";

/** Only ever redirect to a local path (open-redirect guard). */
export const safeNext = (raw: unknown): string => {
  const s = typeof raw === "string" ? raw : "";
  return s.startsWith("/") && !s.startsWith("//") ? s : "/";
};

type SessionUser = { id: number; telegramId: bigint | null };

/** Shared sign-in tail: merge guest cart, rotate jti, set the cookie. */
export async function establishSession(
  req: FastifyRequest,
  reply: FastifyReply,
  user: SessionUser,
): Promise<void> {
  const guestCart = readGuestCart(req);
  for (const line of guestCart) {
    const product = await getProduct(prisma, line.p);
    if (product?.isActive) await addToCart(prisma, user.id, line.p, line.q);
  }
  if (guestCart.length) writeGuestCart(reply, []);

  const jti = newJti();
  await setSetting(prisma, shopSessionJtiKey(user.id), jti);
  const { raw } = makeCustomerSession(user.id, user.telegramId, jti);
  void reply.setCookie(SHOP_COOKIE_NAME, raw, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: config.WEB_COOKIE_SECURE,
    maxAge: SHOP_SESSION_TTL_HOURS * 3600,
  });
}

/** Render /login with optional error/notice keys (already-translated msgs). */
async function renderLogin(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: { next?: string; ref?: string; error?: string; notice?: string; identifier?: string; code?: number } = {},
) {
  const ctx = await shopContext(req, "/login");
  const params = new URLSearchParams();
  params.set("next", safeNext(opts.next));
  if (opts.ref) params.set("ref", opts.ref.slice(0, 16));
  return reply.code(opts.code ?? 200).view("login.njk", {
    ...ctx,
    bot_username: botUsername() ?? "",
    auth_url: `/auth/telegram?${params.toString()}`,
    next: safeNext(opts.next),
    error: opts.error ?? null,
    notice: opts.notice ?? null,
    identifier: opts.identifier ?? "",
  });
}

const authRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { next?: string; ref?: string; reset?: string } }>(
    "/login",
    async (req, reply) => {
      const ctx = await shopContext(req, "/login");
      return renderLogin(req, reply, {
        next: req.query.next,
        ref: req.query.ref,
        notice: req.query.reset ? t("web.login_reset_done", ctx.lang) : undefined,
      });
    },
  );

  // ---- Password login ----
  app.post<{ Body: { identifier?: string; password?: string; next?: string } }>(
    "/login",
    async (req, reply) => {
      const ctx = await shopContext(req, "/login");
      const identifier = (req.body.identifier ?? "").trim();
      const password = req.body.password ?? "";
      const user = identifier ? await findUserByLoginIdentifier(prisma, identifier) : null;
      // Generic failure for every miss (no enumeration): unknown identifier,
      // no password set, wrong password.
      if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
        return renderLogin(req, reply, {
          next: req.body.next,
          error: t("web.login_failed", ctx.lang),
          identifier,
          code: 403,
        });
      }
      if (user.banned) {
        return renderLogin(req, reply, {
          next: req.body.next,
          error: t("web.error_message", ctx.lang),
          code: 403,
        });
      }
      await establishSession(req, reply, user);
      return reply.code(303).redirect(safeNext(req.body.next));
    },
  );

  // ---- Telegram login (lookup-only — never creates accounts) ----
  app.get<{ Querystring: Record<string, string> }>("/auth/telegram", async (req, reply) => {
    const { next, ref, ...tgParams } = req.query;
    const ctx = await shopContext(req, "/login");
    const auth = verifyTelegramLogin(tgParams);
    if (!auth) {
      logger.warn("Storefront: rejected Telegram login (bad hash or stale auth_date)");
      return renderLogin(req, reply, { next, ref, error: t("web.error_message", ctx.lang), code: 403 });
    }
    const user = await getUserByTelegramId(prisma, auth.id);
    if (!user) {
      return renderLogin(req, reply, { next, ref, error: t("web.login_tg_unlinked", ctx.lang), code: 403 });
    }
    if (user.banned) {
      return renderLogin(req, reply, { next, ref, error: t("web.error_message", ctx.lang), code: 403 });
    }
    await establishSession(req, reply, user);
    return reply.code(303).redirect(safeNext(next));
  });

  // Logout — POST only (state change), rotates the server-side jti.
  app.post("/logout", async (req, reply) => {
    const { optionalCustomer } = await import("../plugins/auth");
    const customer = await optionalCustomer(req);
    if (customer) {
      await setSetting(prisma, shopSessionJtiKey(customer.userId), newJti());
    }
    void reply.clearCookie(SHOP_COOKIE_NAME, { path: "/" });
    return reply.code(303).redirect("/");
  });
};

export default authRoutes;
```

Note: the old `/auth/telegram` upsert + `ref` referral attribution is intentionally gone — referral attribution now happens at /register (web) and /start (bot). `ref` still round-trips in the widget URL so a future register link can carry it.

- [ ] **Step 4: Rework login.njk**

Replace `apps/storefront/views/login.njk`:

```njk
{% extends "base.njk" %}
{% import "_macros.njk" as ui %}

{% block title %}{{ t('web.login_title', lang) }} — {{ shop_name }}{% endblock %}

{% block content %}
<div class="card card-pad max-w-md mx-auto py-10">
  <div class="text-center">
    <i data-lucide="log-in" class="w-10 h-10 text-pine mx-auto"></i>
    <h1 class="font-display text-2xl font-semibold mt-4">{{ t('web.login_title', lang) }}</h1>
    <p class="text-sm text-ink-soft mt-2">{{ t('web.login_hint', lang) }}</p>
  </div>

  {% if error %}
  <div class="mt-4">{{ ui.flash(error, 'error') }}</div>
  {% endif %}
  {% if notice %}
  <div class="mt-4">{{ ui.flash(notice, 'success') }}</div>
  {% endif %}

  <form method="post" action="/login" class="mt-6 space-y-4">
    <input type="hidden" name="next" value="{{ next }}">
    <div>
      <label class="text-sm font-semibold" for="identifier">{{ t('web.login_identifier', lang) }}</label>
      <input class="field mt-1" type="text" id="identifier" name="identifier" value="{{ identifier }}"
             autocomplete="username" required>
    </div>
    <div>
      <label class="text-sm font-semibold" for="password">{{ t('web.login_password', lang) }}</label>
      <input class="field mt-1" type="password" id="password" name="password"
             autocomplete="current-password" required>
    </div>
    <button type="submit" class="btn btn-primary w-full">{{ t('web.login_submit', lang) }}</button>
    <div class="flex items-center justify-between text-sm">
      <a href="/forgot" class="text-pine hover:underline">{{ t('web.forgot_link', lang) }}</a>
      <a href="/register{% if next != '/' %}?next={{ next | urlencode }}{% endif %}" class="text-pine hover:underline">{{ t('web.register_cta', lang) }}</a>
    </div>
  </form>

  {% if bot_username %}
  <div class="mt-6 flex items-center gap-3 text-xs text-ink-faint">
    <span class="flex-1 border-t border-line"></span>{{ t('web.login_or', lang) }}<span class="flex-1 border-t border-line"></span>
  </div>
  <div class="mt-4 flex justify-center">
    {# Official Telegram Login Widget — lookup-only: signs in linked accounts. #}
    <script async src="https://telegram.org/js/telegram-widget.js?22"
            data-telegram-login="{{ bot_username }}"
            data-size="large"
            data-radius="12"
            data-auth-url="{{ auth_url }}"
            data-request-access="write"></script>
    <noscript class="text-xs text-ink-faint">{{ t('web.login_telegram', lang) }}</noscript>
  </div>
  {% endif %}
</div>
{% endblock %}
```

(Check `packages/web-ui/views/_macros.njk` `flash` macro kinds — it takes `kind="info"`; if there is no `success` kind, use `info`.)

- [ ] **Step 5: Add the tests**

Append to `apps/storefront/test/storefront.test.ts` (inside the existing file, reusing `app`/`prisma`):

```ts
describe("password login", () => {
  let pwUserId: number;
  beforeAll(async () => {
    const { hashPassword } = await import("@app/core/password");
    const u = await prisma.user.create({
      data: {
        telegramId: null,
        loginUsername: "webbuyer",
        email: "web@buyer.test",
        passwordHash: hashPassword("hunter2-ok"),
        referralCode: "WEBB01",
      },
    });
    pwUserId = u.id;
  });

  it("signs in with username + password and reaches /account", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/login",
      payload: { identifier: "WebBuyer", password: "hunter2-ok", next: "/account" },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/account");
    const cookie = res.headers["set-cookie"];
    const acc = await app.inject({
      method: "GET",
      url: "/account",
      headers: { cookie: Array.isArray(cookie) ? cookie.join("; ") : String(cookie) },
    });
    expect(acc.statusCode).toBe(200);
    expect(acc.body).toContain("webbuyer");
  });

  it("rejects a wrong password with the generic message", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/login",
      payload: { identifier: "webbuyer", password: "nope" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Wrong username or password");
  });

  it("rejects an unknown identifier with the SAME generic message", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/login",
      payload: { identifier: "ghost", password: "nope" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Wrong username or password");
  });

  it("rejects a banned user", async () => {
    await prisma.user.update({ where: { id: pwUserId }, data: { banned: true } });
    const res = await app.inject({
      method: "POST",
      url: "/login",
      payload: { identifier: "webbuyer", password: "hunter2-ok" },
    });
    expect(res.statusCode).toBe(403);
    await prisma.user.update({ where: { id: pwUserId }, data: { banned: false } });
  });
});

describe("telegram login is lookup-only", () => {
  function signedTgParams(id: number): Record<string, string> {
    // Build a VALID widget payload with the test BOT_TOKEN (setup-env).
    const { createHash, createHmac } = require("node:crypto") as typeof import("node:crypto");
    const fields: Record<string, string> = {
      id: String(id),
      first_name: "Tg",
      auth_date: String(Math.floor(Date.now() / 1000)),
    };
    const checkString = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
    const secretKey = createHash("sha256").update(process.env.BOT_TOKEN!).digest();
    const hash = createHmac("sha256", secretKey).update(checkString).digest("hex");
    return { ...fields, hash };
  }

  it("signs in an existing bot member", async () => {
    await prisma.user.create({
      data: { telegramId: 424242n, referralCode: "TGOK42" },
    });
    const params = new URLSearchParams({ ...signedTgParams(424242), next: "/account" });
    const res = await app.inject({ method: "GET", url: `/auth/telegram?${params}` });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/account");
  });

  it("does NOT create an account for an unknown telegram id", async () => {
    const before = await prisma.user.count();
    const params = new URLSearchParams(signedTgParams(999999111));
    const res = await app.inject({ method: "GET", url: `/auth/telegram?${params}` });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("isn't registered yet");
    expect(await prisma.user.count()).toBe(before);
  });
});
```

- [ ] **Step 6: Run the storefront tests**

Run: `pnpm --filter @app/storefront test`
Expected: PASS — new blocks green, pre-existing tests untouched. (If an existing test asserted the OLD login page copy "no password needed", update it to the new `web.login_hint` text.)

- [ ] **Step 7: Typecheck + commit**

Run: `pnpm --filter @app/storefront typecheck`

```bash
git add apps/storefront/src/auth.ts apps/storefront/src/plugins/auth.ts apps/storefront/src/routes/auth.ts apps/storefront/views/login.njk apps/storefront/test/storefront.test.ts
git commit -m "feat(storefront): password login + lookup-only Telegram login; sessions keyed by userId"
```

---

### Task 7: /register

**Files:**
- Modify: `apps/storefront/src/routes/auth.ts` (add routes)
- Create: `apps/storefront/views/register.njk`
- Modify: `apps/storefront/test/storefront.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/storefront/test/storefront.test.ts`:

```ts
describe("register", () => {
  it("renders the form", async () => {
    const res = await app.inject({ method: "GET", url: "/register" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Create account");
  });

  it("creates an account, signs in, and attributes a referral", async () => {
    await prisma.user.create({ data: { telegramId: 515151n, referralCode: "REFREG" } });
    const res = await app.inject({
      method: "POST",
      url: "/register",
      payload: {
        username: "Newbie_1",
        email: "new@user.test",
        password: "longenough",
        password2: "longenough",
        ref: "refreg",
        next: "/account",
      },
    });
    expect(res.statusCode).toBe(303);
    const row = await prisma.user.findFirst({ where: { loginUsername: "newbie_1" } });
    expect(row).not.toBeNull();
    expect(row!.telegramId).toBeNull();
    expect(row!.email).toBe("new@user.test");
    const referrer = await prisma.user.findUnique({ where: { referralCode: "REFREG" } });
    expect(row!.referredById).toBe(referrer!.id);
  });

  it("rejects bad input field by field", async () => {
    const bad = async (payload: Record<string, string>, msg: string) => {
      const res = await app.inject({ method: "POST", url: "/register", payload });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain(msg);
    };
    await bad({ username: "x", email: "a@b.c", password: "longenough", password2: "longenough" }, "3–32 characters");
    await bad({ username: "okname", email: "not-an-email", password: "longenough", password2: "longenough" }, "valid email");
    await bad({ username: "okname", email: "a@b.c", password: "short", password2: "short" }, "at least 8");
    await bad({ username: "okname", email: "a@b.c", password: "longenough", password2: "different1" }, "don&#39;t match");
  });

  it("rejects a duplicate username with a 409-style field error", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/register",
      payload: { username: "newbie_1", email: "other@user.test", password: "longenough", password2: "longenough" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("taken");
  });
});
```

Note on the mismatch assertion: Nunjucks autoescapes `'` to `&#39;` — assert the escaped form.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @app/storefront test -- -t register`
Expected: FAIL — GET /register 404.

- [ ] **Step 3: Add the routes**

In `apps/storefront/src/routes/auth.ts`, inside `authRoutes` (after the Telegram block), add:

```ts
  // ---- Web registration (spec §3): telegramId = null until linked ----
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  interface RegisterBody {
    username?: string;
    email?: string;
    password?: string;
    password2?: string;
    ref?: string;
    next?: string;
  }

  async function renderRegister(
    req: FastifyRequest,
    reply: FastifyReply,
    opts: { next?: string; ref?: string; error?: string; values?: Record<string, string>; code?: number } = {},
  ) {
    const ctx = await shopContext(req, "/login");
    return reply.code(opts.code ?? 200).view("register.njk", {
      ...ctx,
      next: safeNext(opts.next),
      ref: (opts.ref ?? "").slice(0, 16),
      error: opts.error ?? null,
      values: opts.values ?? {},
    });
  }

  app.get<{ Querystring: { next?: string; ref?: string } }>("/register", async (req, reply) =>
    renderRegister(req, reply, { next: req.query.next, ref: req.query.ref }),
  );

  app.post<{ Body: RegisterBody }>("/register", async (req, reply) => {
    const ctx = await shopContext(req, "/login");
    const username = (req.body.username ?? "").trim().toLowerCase();
    const email = (req.body.email ?? "").trim().toLowerCase();
    const password = req.body.password ?? "";
    const back = (error: string) =>
      renderRegister(req, reply, {
        next: req.body.next,
        ref: req.body.ref,
        error,
        values: { username, email },
        code: 400,
      });

    const { LOGIN_USERNAME_RE } = await import("@app/db");
    if (!LOGIN_USERNAME_RE.test(username)) return back(t("web.register_username_invalid", ctx.lang));
    if (!EMAIL_RE.test(email)) return back(t("web.register_email_invalid", ctx.lang));
    if (password.length < 8) return back(t("web.register_password_short", ctx.lang));
    if (password !== (req.body.password2 ?? "")) return back(t("web.register_password_mismatch", ctx.lang));

    const { hashPassword } = await import("@app/core/password");
    const { createWebUser } = await import("@app/db");
    const { ValidationError } = await import("@app/core/errors");
    try {
      const user = await createWebUser(prisma, {
        loginUsername: username,
        email,
        passwordHash: hashPassword(password),
        referredByCode: req.body.ref ? req.body.ref.toUpperCase() : null,
      });
      await establishSession(req, reply, user);
      return reply.code(303).redirect(safeNext(req.body.next));
    } catch (e) {
      if (e instanceof ValidationError) return back(t(e.message, ctx.lang));
      throw e;
    }
  });
```

(Adjust to static top-of-file imports instead of inline `await import(...)` — inline shown here only to make the diff additive; the executor should hoist `hashPassword`, `createWebUser`, `LOGIN_USERNAME_RE`, and `ValidationError` into the existing import block. `ValidationError.message` holds the i18n key — that is how the crud layer reports `web.register_username_taken` / `web.register_email_taken`.)

- [ ] **Step 4: Create the view**

`apps/storefront/views/register.njk`:

```njk
{% extends "base.njk" %}
{% import "_macros.njk" as ui %}

{% block title %}{{ t('web.register_title', lang) }} — {{ shop_name }}{% endblock %}

{% block content %}
<div class="card card-pad max-w-md mx-auto py-10">
  <div class="text-center">
    <i data-lucide="user-plus" class="w-10 h-10 text-pine mx-auto"></i>
    <h1 class="font-display text-2xl font-semibold mt-4">{{ t('web.register_title', lang) }}</h1>
  </div>

  {% if error %}
  <div class="mt-4">{{ ui.flash(error, 'error') }}</div>
  {% endif %}

  <form method="post" action="/register" class="mt-6 space-y-4">
    <input type="hidden" name="next" value="{{ next }}">
    <input type="hidden" name="ref" value="{{ ref }}">
    <div>
      <label class="text-sm font-semibold" for="username">{{ t('web.register_username', lang) }}</label>
      <input class="field mt-1" type="text" id="username" name="username" value="{{ values.username }}"
             autocomplete="username" required minlength="3" maxlength="32" pattern="[a-zA-Z0-9_]+">
      <p class="text-xs text-ink-faint mt-1">{{ t('web.register_username_help', lang) }}</p>
    </div>
    <div>
      <label class="text-sm font-semibold" for="email">{{ t('web.register_email', lang) }}</label>
      <input class="field mt-1" type="email" id="email" name="email" value="{{ values.email }}"
             autocomplete="email" required>
    </div>
    <div>
      <label class="text-sm font-semibold" for="password">{{ t('web.login_password', lang) }}</label>
      <input class="field mt-1" type="password" id="password" name="password"
             autocomplete="new-password" required minlength="8">
    </div>
    <div>
      <label class="text-sm font-semibold" for="password2">{{ t('web.register_password2', lang) }}</label>
      <input class="field mt-1" type="password" id="password2" name="password2"
             autocomplete="new-password" required minlength="8">
    </div>
    <button type="submit" class="btn btn-primary w-full">{{ t('web.register_submit', lang) }}</button>
    <div class="text-center text-sm">
      <a href="/login{% if next != '/' %}?next={{ next | urlencode }}{% endif %}" class="text-pine hover:underline">{{ t('web.register_have_account', lang) }}</a>
    </div>
  </form>
</div>
{% endblock %}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @app/storefront test -- -t register`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/storefront/src/routes/auth.ts apps/storefront/views/register.njk apps/storefront/test/storefront.test.ts
git commit -m "feat(storefront): /register — web accounts with referral attribution"
```

---

### Task 8: /forgot + /reset/:token

**Files:**
- Create: `apps/storefront/src/routes/forgot.ts`
- Create: `apps/storefront/views/forgot.njk`
- Create: `apps/storefront/views/reset.njk`
- Modify: `apps/storefront/src/server.ts` (register the route module)
- Modify: `apps/storefront/test/setup-env.ts` (SMTP env so `isSmtpEnabled()` is true in tests)
- Modify: `apps/storefront/test/storefront.test.ts`

- [ ] **Step 1: Enable SMTP in the test env**

In `apps/storefront/test/setup-env.ts`, after the existing `process.env.*` lines:

```ts
process.env.SMTP_HOST = "smtp.test.invalid";
process.env.SMTP_FROM = "Shop <no-reply@test.invalid>";
```

- [ ] **Step 2: Write the failing tests**

Append to `apps/storefront/test/storefront.test.ts`. The mailer must be mocked at the top of the file (vi.mock is hoisted — put it right after the imports):

```ts
import { vi } from "vitest"; // merge into the existing vitest import

vi.mock("@app/core/mailer", () => ({
  sendMail: vi.fn().mockResolvedValue(undefined),
}));
```

Then the describe block:

```ts
describe("forgot + reset password", () => {
  it("always claims success, and mails only real accounts", async () => {
    const { sendMail } = await import("@app/core/mailer");
    const { hashPassword } = await import("@app/core/password");
    await prisma.user.create({
      data: {
        loginUsername: "forgetful",
        email: "forget@me.test",
        passwordHash: hashPassword("oldpass-123"),
        referralCode: "FORG01",
      },
    });

    const real = await app.inject({ method: "POST", url: "/forgot", payload: { email: "forget@me.test" } });
    expect(real.statusCode).toBe(200);
    expect(real.body).toContain("on its way");

    const fake = await app.inject({ method: "POST", url: "/forgot", payload: { email: "ghost@no.test" } });
    expect(fake.statusCode).toBe(200);
    expect(fake.body).toContain("on its way"); // identical rendering

    expect(sendMail).toHaveBeenCalledTimes(1);
    const text = (sendMail as ReturnType<typeof vi.fn>).mock.calls[0]![0].text as string;
    expect(text).toMatch(/\/reset\/[A-Za-z0-9_-]{40,}/);
  });

  it("resets the password with a valid token, once, and invalidates sessions", async () => {
    const { createPasswordResetToken } = await import("@app/db");
    const { verifyPassword } = await import("@app/core/password");
    const user = (await prisma.user.findFirst({ where: { email: "forget@me.test" } }))!;
    const { token } = await createPasswordResetToken(prisma, user.id);

    const form = await app.inject({ method: "GET", url: `/reset/${token}` });
    expect(form.statusCode).toBe(200);
    expect(form.body).toContain("new password");

    const res = await app.inject({
      method: "POST",
      url: `/reset/${token}`,
      payload: { password: "brandnew-99", password2: "brandnew-99" },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login?reset=1");
    const updated = (await prisma.user.findUnique({ where: { id: user.id } }))!;
    expect(verifyPassword("brandnew-99", updated.passwordHash!)).toBe(true);

    // Token is burned: the second use fails.
    const again = await app.inject({
      method: "POST",
      url: `/reset/${token}`,
      payload: { password: "another-99", password2: "another-99" },
    });
    expect(again.statusCode).toBe(400);
    expect(again.body).toContain("invalid or has expired");
  });

  it("rejects an expired token", async () => {
    const { createPasswordResetToken } = await import("@app/db");
    const user = (await prisma.user.findFirst({ where: { email: "forget@me.test" } }))!;
    const { token } = await createPasswordResetToken(prisma, user.id, -1);
    const res = await app.inject({
      method: "POST",
      url: `/reset/${token}`,
      payload: { password: "whatever-99", password2: "whatever-99" },
    });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @app/storefront test -- -t "forgot"`
Expected: FAIL — POST /forgot 404.

- [ ] **Step 4: Implement the routes**

`apps/storefront/src/routes/forgot.ts`:

```ts
/**
 * Forgot/reset password (spec §4). Anti-enumeration: /forgot ALWAYS renders
 * the same "sent" notice; only real accounts get mail. Tokens are 1-hour,
 * single-use, stored hashed (crud/webauth). A successful reset rotates the
 * user's session jti — every existing session dies. Reset links are
 * credentials: never log them.
 */
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { config, isSmtpEnabled } from "@app/core/config";
import { t } from "@app/core/i18n";
import { logger } from "@app/core/logger";
import { sendMail } from "@app/core/mailer";
import { hashPassword } from "@app/core/password";
import {
  prisma,
  setSetting,
  createPasswordResetToken,
  consumePasswordResetToken,
  setLoginCredentials,
} from "@app/db";
import { newJti, shopSessionJtiKey } from "../auth";
import { shopContext } from "../shop";

/** Public origin for the reset link (mirrors tokopay's shopUrl resolution). */
function publicBase(req: FastifyRequest): string {
  const fromConfig = config.SHOP_PUBLIC_URL ?? config.PUBLIC_URL;
  if (fromConfig) return fromConfig.replace(/\/+$/, "");
  return `${req.protocol}://${req.headers.host ?? "localhost"}`;
}

const forgotRoutes: FastifyPluginAsync = async (app) => {
  app.get("/forgot", async (req, reply) => {
    const ctx = await shopContext(req, "/login");
    return reply.view("forgot.njk", { ...ctx, sent: false, unavailable: !isSmtpEnabled() });
  });

  app.post<{ Body: { email?: string } }>("/forgot", async (req, reply) => {
    const ctx = await shopContext(req, "/login");
    if (!isSmtpEnabled()) {
      return reply.view("forgot.njk", { ...ctx, sent: false, unavailable: true });
    }
    const email = (req.body.email ?? "").trim().toLowerCase();
    if (email) {
      const user = await prisma.user.findUnique({ where: { email } });
      if (user && !user.banned) {
        const { token } = await createPasswordResetToken(prisma, user.id);
        const link = `${publicBase(req)}/reset/${token}`;
        try {
          // Bilingual plain-text mail, same convention as notifier templates.
          await sendMail({
            to: email,
            subject: `${ctx.shop_name} — reset password`,
            text:
              `Click to set a new password (valid 1 hour):\n${link}\n\n` +
              `If you didn't request this, ignore this email — your password is unchanged.\n\n` +
              `Klik untuk membuat kata sandi baru (berlaku 1 jam):\n${link}\n\n` +
              `Abaikan email ini jika kamu tidak memintanya — kata sandimu tidak berubah.`,
          });
        } catch (e) {
          // Render the same notice anyway (no enumeration via error pages).
          logger.error({ err: e }, "Failed to send password reset mail");
        }
      }
    }
    return reply.view("forgot.njk", { ...ctx, sent: true, unavailable: false });
  });

  app.get<{ Params: { token: string } }>("/reset/:token", async (req, reply) => {
    const ctx = await shopContext(req, "/login");
    // Render the form without consuming — GETs must stay side-effect free.
    return reply.view("reset.njk", { ...ctx, token: req.params.token, error: null });
  });

  app.post<{ Params: { token: string }; Body: { password?: string; password2?: string } }>(
    "/reset/:token",
    async (req, reply) => {
      const ctx = await shopContext(req, "/login");
      const password = req.body.password ?? "";
      const back = (error: string) =>
        reply.code(400).view("reset.njk", { ...ctx, token: req.params.token, error });

      if (password.length < 8) return back(t("web.register_password_short", ctx.lang));
      if (password !== (req.body.password2 ?? "")) return back(t("web.register_password_mismatch", ctx.lang));

      const user = await consumePasswordResetToken(prisma, req.params.token);
      if (!user) return back(t("web.reset_invalid", ctx.lang));

      await setLoginCredentials(prisma, user.id, { passwordHash: hashPassword(password) });
      // Kill every live session for this account.
      await setSetting(prisma, shopSessionJtiKey(user.id), newJti());
      return reply.code(303).redirect("/login?reset=1");
    },
  );
};

export default forgotRoutes;
```

- [ ] **Step 5: Create the views**

`apps/storefront/views/forgot.njk`:

```njk
{% extends "base.njk" %}
{% import "_macros.njk" as ui %}

{% block title %}{{ t('web.forgot_title', lang) }} — {{ shop_name }}{% endblock %}

{% block content %}
<div class="card card-pad max-w-md mx-auto py-10">
  <div class="text-center">
    <i data-lucide="key-round" class="w-10 h-10 text-pine mx-auto"></i>
    <h1 class="font-display text-2xl font-semibold mt-4">{{ t('web.forgot_title', lang) }}</h1>
    <p class="text-sm text-ink-soft mt-2">{{ t('web.forgot_hint', lang) }}</p>
  </div>

  {% if unavailable %}
  <div class="mt-6">{{ ui.flash(t('web.forgot_unavailable', lang), 'error') }}</div>
  {% elif sent %}
  <div class="mt-6">{{ ui.flash(t('web.forgot_sent', lang), 'info') }}</div>
  {% else %}
  <form method="post" action="/forgot" class="mt-6 space-y-4">
    <div>
      <label class="text-sm font-semibold" for="email">{{ t('web.register_email', lang) }}</label>
      <input class="field mt-1" type="email" id="email" name="email" autocomplete="email" required>
    </div>
    <button type="submit" class="btn btn-primary w-full">{{ t('web.forgot_submit', lang) }}</button>
  </form>
  {% endif %}

  <div class="text-center text-sm mt-6">
    <a href="/login" class="text-pine hover:underline">{{ t('web.register_have_account', lang) }}</a>
  </div>
</div>
{% endblock %}
```

`apps/storefront/views/reset.njk`:

```njk
{% extends "base.njk" %}
{% import "_macros.njk" as ui %}

{% block title %}{{ t('web.reset_title', lang) }} — {{ shop_name }}{% endblock %}

{% block content %}
<div class="card card-pad max-w-md mx-auto py-10">
  <div class="text-center">
    <i data-lucide="lock-keyhole" class="w-10 h-10 text-pine mx-auto"></i>
    <h1 class="font-display text-2xl font-semibold mt-4">{{ t('web.reset_title', lang) }}</h1>
  </div>

  {% if error %}
  <div class="mt-4">{{ ui.flash(error, 'error') }}</div>
  {% endif %}

  <form method="post" action="/reset/{{ token }}" class="mt-6 space-y-4">
    <div>
      <label class="text-sm font-semibold" for="password">{{ t('web.login_password', lang) }}</label>
      <input class="field mt-1" type="password" id="password" name="password"
             autocomplete="new-password" required minlength="8">
    </div>
    <div>
      <label class="text-sm font-semibold" for="password2">{{ t('web.register_password2', lang) }}</label>
      <input class="field mt-1" type="password" id="password2" name="password2"
             autocomplete="new-password" required minlength="8">
    </div>
    <button type="submit" class="btn btn-primary w-full">{{ t('web.reset_submit', lang) }}</button>
  </form>
</div>
{% endblock %}
```

- [ ] **Step 6: Register the routes**

In `apps/storefront/src/server.ts` add `import forgotRoutes from "./routes/forgot";` next to the other route imports, and `await app.register(forgotRoutes);` after `await app.register(authRoutes);`.

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @app/storefront test -- -t "forgot"`
Expected: PASS (3 tests).

- [ ] **Step 8: Commit**

```bash
git add apps/storefront/src/routes/forgot.ts apps/storefront/views/forgot.njk apps/storefront/views/reset.njk apps/storefront/src/server.ts apps/storefront/test/setup-env.ts apps/storefront/test/storefront.test.ts
git commit -m "feat(storefront): forgot/reset password via email (SMTP, hashed single-use tokens)"
```

---

### Task 9: /account/settings — credentials + Telegram linking

**Files:**
- Create: `apps/storefront/src/routes/settings.ts`
- Create: `apps/storefront/views/settings.njk`
- Modify: `apps/storefront/views/account.njk` (menu entry)
- Modify: `apps/storefront/src/server.ts` (register routes)
- Modify: `apps/storefront/test/storefront.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/storefront/test/storefront.test.ts`. Reuse the existing helper pattern for an authenticated cookie — add this helper near the top of the file (after `beforeAll`):

```ts
async function loginAs(identifier: string, password: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/login", payload: { identifier, password } });
  const c = res.headers["set-cookie"];
  return Array.isArray(c) ? c.join("; ") : String(c);
}

function csrfFrom(html: string): string {
  return /name="csrf_token" value="([^"]+)"/.exec(html)![1]!;
}
```

Then:

```ts
describe("account settings", () => {
  let cookie: string;
  let csrf: string;
  beforeAll(async () => {
    const { hashPassword } = await import("@app/core/password");
    await prisma.user.create({
      data: {
        loginUsername: "settingsuser",
        email: "settings@u.test",
        passwordHash: hashPassword("original-pw"),
        referralCode: "SETT01",
      },
    });
    cookie = await loginAs("settingsuser", "original-pw");
    const page = await app.inject({ method: "GET", url: "/account/settings", headers: { cookie } });
    expect(page.statusCode).toBe(200);
    csrf = csrfFrom(page.body);
  });

  it("redirects anonymous visitors to /login", async () => {
    const res = await app.inject({ method: "GET", url: "/account/settings" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("/login");
  });

  it("rejects a credentials change without CSRF", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/account/settings/credentials",
      headers: { cookie },
      payload: { email: "evil@u.test" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("changes the password when the current password is right", async () => {
    const { verifyPassword } = await import("@app/core/password");
    const res = await app.inject({
      method: "POST",
      url: "/account/settings/credentials",
      headers: { cookie },
      payload: {
        csrf_token: csrf,
        username: "settingsuser",
        email: "settings@u.test",
        current_password: "original-pw",
        new_password: "second-pw-99",
      },
    });
    expect(res.statusCode).toBe(303);
    const row = (await prisma.user.findFirst({ where: { loginUsername: "settingsuser" } }))!;
    expect(verifyPassword("second-pw-99", row.passwordHash!)).toBe(true);
  });

  it("refuses a password change with the wrong current password", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/account/settings/credentials",
      headers: { cookie },
      payload: {
        csrf_token: csrf,
        username: "settingsuser",
        email: "settings@u.test",
        current_password: "WRONG",
        new_password: "hacked-pw-99",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Current password is wrong");
  });

  it("links a Telegram account via signed widget params", async () => {
    const { createHash, createHmac } = await import("node:crypto");
    const fields: Record<string, string> = {
      id: "636363",
      first_name: "Linked",
      username: "linkedtg",
      auth_date: String(Math.floor(Date.now() / 1000)),
    };
    const checkString = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
    const secretKey = createHash("sha256").update(process.env.BOT_TOKEN!).digest();
    const hash = createHmac("sha256", secretKey).update(checkString).digest("hex");
    const params = new URLSearchParams({ ...fields, hash });

    const res = await app.inject({
      method: "GET",
      url: `/account/settings/link-telegram?${params}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(303);
    const row = (await prisma.user.findFirst({ where: { loginUsername: "settingsuser" } }))!;
    expect(row.telegramId).toBe(636363n);
  });

  it("refuses linking a telegramId owned by another account", async () => {
    await prisma.user.create({ data: { telegramId: 737373n, referralCode: "TAKEN7" } });
    const { createHash, createHmac } = await import("node:crypto");
    const fields: Record<string, string> = {
      id: "737373",
      auth_date: String(Math.floor(Date.now() / 1000)),
    };
    const checkString = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
    const secretKey = createHash("sha256").update(process.env.BOT_TOKEN!).digest();
    const hash = createHmac("sha256", secretKey).update(checkString).digest("hex");
    const params = new URLSearchParams({ ...fields, hash });
    const res = await app.inject({
      method: "GET",
      url: `/account/settings/link-telegram?${params}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(303); // back to settings with the error flash
    const follow = await app.inject({ method: "GET", url: res.headers.location as string, headers: { cookie } });
    expect(follow.body).toContain("already linked to another member");
    const row = (await prisma.user.findFirst({ where: { loginUsername: "settingsuser" } }))!;
    expect(row.telegramId).toBe(636363n); // unchanged
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @app/storefront test -- -t "account settings"`
Expected: FAIL — GET /account/settings 404.

- [ ] **Step 3: Implement the routes**

`apps/storefront/src/routes/settings.ts`:

```ts
/**
 * Member settings (spec §5): sign-in details (login username / email /
 * password) + Telegram linking. Changing the password requires the current
 * one when a password is already set (bot members signing in via Telegram
 * have none yet — they create it here). Linking refuses a telegramId that
 * belongs to another account: no merging.
 */
import type { FastifyPluginAsync } from "fastify";
import { botUsername } from "@app/core/runtime";
import { t } from "@app/core/i18n";
import { ValidationError } from "@app/core/errors";
import { hashPassword, verifyPassword } from "@app/core/password";
import {
  prisma,
  getUser,
  setLoginCredentials,
  linkTelegram,
  LOGIN_USERNAME_RE,
} from "@app/db";
import { verifyTelegramLogin } from "../auth";
import { currentCustomer, csrfProtect } from "../plugins/auth";
import { shopContext } from "../shop";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const settingsRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { saved?: string; linked?: string; err?: string } }>(
    "/account/settings",
    { preHandler: currentCustomer },
    async (req, reply) => {
      const ctx = await shopContext(req, "/account");
      const customer = req.customer!;
      const errKey = req.query.err === "tg_taken" ? "web.settings_tg_taken"
        : req.query.err === "tg_invalid" ? "web.error_message"
        : null;
      return reply.view("settings.njk", {
        ...ctx,
        customer,
        bot_username: botUsername() ?? "",
        values: {
          username: customer.user.loginUsername ?? "",
          email: customer.user.email ?? "",
        },
        has_password: Boolean(customer.user.passwordHash),
        tg_linked: customer.user.telegramId != null,
        tg_name: customer.user.username ?? customer.user.fullName ?? String(customer.user.telegramId ?? ""),
        saved: Boolean(req.query.saved),
        linked: Boolean(req.query.linked),
        error: errKey ? t(errKey, ctx.lang) : null,
      });
    },
  );

  app.post<{
    Body: {
      csrf_token?: string;
      username?: string;
      email?: string;
      current_password?: string;
      new_password?: string;
    };
  }>("/account/settings/credentials", { preHandler: csrfProtect }, async (req, reply) => {
    const ctx = await shopContext(req, "/account");
    const customer = req.customer!;
    const username = (req.body.username ?? "").trim().toLowerCase();
    const email = (req.body.email ?? "").trim().toLowerCase();
    const newPassword = req.body.new_password ?? "";

    const back = async (error: string) => {
      const fresh = await getUser(prisma, customer.userId);
      return reply.code(400).view("settings.njk", {
        ...ctx,
        customer,
        bot_username: botUsername() ?? "",
        values: { username, email },
        has_password: Boolean(fresh?.passwordHash),
        tg_linked: fresh?.telegramId != null,
        tg_name: fresh?.username ?? fresh?.fullName ?? "",
        saved: false,
        linked: false,
        error,
      });
    };

    if (username && !LOGIN_USERNAME_RE.test(username)) return back(t("web.register_username_invalid", ctx.lang));
    if (email && !EMAIL_RE.test(email)) return back(t("web.register_email_invalid", ctx.lang));

    const changes: { loginUsername?: string; email?: string; passwordHash?: string } = {};
    if (username && username !== customer.user.loginUsername) changes.loginUsername = username;
    if (email && email !== customer.user.email) changes.email = email;
    if (newPassword) {
      if (newPassword.length < 8) return back(t("web.register_password_short", ctx.lang));
      // An account that already has a password must prove it before changing.
      if (
        customer.user.passwordHash &&
        !verifyPassword(req.body.current_password ?? "", customer.user.passwordHash)
      ) {
        return back(t("web.settings_wrong_password", ctx.lang));
      }
      changes.passwordHash = hashPassword(newPassword);
    }

    try {
      await setLoginCredentials(prisma, customer.userId, changes);
    } catch (e) {
      if (e instanceof ValidationError) return back(t(e.message, ctx.lang));
      throw e;
    }
    return reply.code(303).redirect("/account/settings?saved=1");
  });

  // Telegram Login Widget redirect target for LINKING (auth handled by the
  // session — the widget only proves ownership of the Telegram account).
  app.get<{ Querystring: Record<string, string> }>(
    "/account/settings/link-telegram",
    { preHandler: currentCustomer },
    async (req, reply) => {
      const customer = req.customer!;
      const auth = verifyTelegramLogin(req.query);
      if (!auth) return reply.code(303).redirect("/account/settings?err=tg_invalid");
      const fullName = [auth.first_name, auth.last_name].filter(Boolean).join(" ") || null;
      const res = await linkTelegram(prisma, customer.userId, auth.id, auth.username ?? null, fullName);
      if (!res.ok) return reply.code(303).redirect("/account/settings?err=tg_taken");
      return reply.code(303).redirect("/account/settings?linked=1");
    },
  );
};

export default settingsRoutes;
```

- [ ] **Step 4: Create the view**

`apps/storefront/views/settings.njk`:

```njk
{% extends "base.njk" %}
{% import "_macros.njk" as ui %}

{% block title %}{{ t('web.settings_title', lang) }} — {{ shop_name }}{% endblock %}

{% block content %}
<h1 class="page-title mb-6">{{ t('web.settings_title', lang) }}</h1>

{% if error %}<div class="mb-4 max-w-md">{{ ui.flash(error, 'error') }}</div>{% endif %}
{% if saved %}<div class="mb-4 max-w-md">{{ ui.flash(t('web.settings_saved', lang), 'info') }}</div>{% endif %}
{% if linked %}<div class="mb-4 max-w-md">{{ ui.flash(t('web.settings_tg_done', lang), 'info') }}</div>{% endif %}

<div class="grid lg:grid-cols-2 gap-6 items-start">
  <div class="card card-pad">
    <h2 class="font-display text-lg font-semibold mb-4">{{ t('web.settings_login_section', lang) }}</h2>
    <form method="post" action="/account/settings/credentials" class="space-y-4">
      {{ ui.csrf_field(customer) }}
      <div>
        <label class="text-sm font-semibold" for="username">{{ t('web.register_username', lang) }}</label>
        <input class="field mt-1" type="text" id="username" name="username" value="{{ values.username }}"
               autocomplete="username" minlength="3" maxlength="32" pattern="[a-zA-Z0-9_]+">
        <p class="text-xs text-ink-faint mt-1">{{ t('web.register_username_help', lang) }}</p>
      </div>
      <div>
        <label class="text-sm font-semibold" for="email">{{ t('web.register_email', lang) }}</label>
        <input class="field mt-1" type="email" id="email" name="email" value="{{ values.email }}" autocomplete="email">
      </div>
      {% if has_password %}
      <div>
        <label class="text-sm font-semibold" for="current_password">{{ t('web.settings_current_password', lang) }}</label>
        <input class="field mt-1" type="password" id="current_password" name="current_password" autocomplete="current-password">
      </div>
      {% endif %}
      <div>
        <label class="text-sm font-semibold" for="new_password">{{ t('web.settings_new_password', lang) }}</label>
        <input class="field mt-1" type="password" id="new_password" name="new_password" autocomplete="new-password" minlength="8">
      </div>
      <button type="submit" class="btn btn-primary">{{ t('web.settings_save', lang) }}</button>
    </form>
  </div>

  <div class="card card-pad">
    <h2 class="font-display text-lg font-semibold mb-4">{{ t('web.settings_tg_section', lang) }}</h2>
    {% if tg_linked %}
    <p class="text-sm text-ink-soft flex items-center gap-2">
      <i data-lucide="check-circle" class="w-4 h-4 text-pine"></i>
      {{ t('web.settings_tg_linked', lang, {name: tg_name}) }}
    </p>
    {% else %}
    <p class="text-sm text-ink-soft mb-4">{{ t('web.settings_tg_hint', lang) }}</p>
    {% if bot_username %}
    <script async src="https://telegram.org/js/telegram-widget.js?22"
            data-telegram-login="{{ bot_username }}"
            data-size="large"
            data-radius="12"
            data-auth-url="/account/settings/link-telegram"
            data-request-access="write"></script>
    {% endif %}
    {% endif %}
  </div>
</div>
{% endblock %}
```

(Check how other templates pass i18n args: if `t` in Nunjucks doesn't accept an args object, render `web.settings_tg_linked` by string-replacing `{name}` in the route and passing the final text instead.)

- [ ] **Step 5: Add the menu entry + register the routes**

In `apps/storefront/views/account.njk`, extend the `menu` array (line 32-37):

```njk
  {% set menu = [
    ['/account/orders', 'shopping-bag', t('web.account_orders', lang)],
    ['/account/referral', 'gift', t('web.account_referral', lang)],
    ['/account/reviews', 'star', t('web.account_reviews', lang)],
    ['/account/support', 'life-buoy', t('web.account_support', lang)],
    ['/account/settings', 'settings', t('web.account_settings', lang)]
  ] %}
```

In `apps/storefront/src/server.ts`: `import settingsRoutes from "./routes/settings";` + `await app.register(settingsRoutes);` after `accountRoutes`.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @app/storefront test -- -t "account settings"`
Expected: PASS (6 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/storefront/src/routes/settings.ts apps/storefront/views/settings.njk apps/storefront/views/account.njk apps/storefront/src/server.ts apps/storefront/test/storefront.test.ts
git commit -m "feat(storefront): account settings — credentials + telegram linking"
```

---

### Task 10: Notification fallout — skip Telegram for web-only buyers, "via Website" marker

**Files:**
- Modify: `packages/db/src/crud/orders.ts:538-556` (approveOrder testimonial payload)
- Modify: `packages/db/src/crud/tokopay.ts:70-75` (buyer DM guard)
- Modify: `packages/db/src/crud/broadcasts.ts:20-30` (recipients need a telegramId)
- Modify: `apps/order-bot/src/payments/binanceInternal.ts:186-190` (buyer DM guard)
- Modify: `apps/notifier/src/templates.ts` (render the marker)
- Modify: `packages/db/src/crud/notifications.test.ts` or a new test in `apps/notifier/src/templates.test.ts`

- [ ] **Step 1: Write the failing template test**

Append to `apps/notifier/src/templates.test.ts`:

```ts
it("appends a via-Website line when the payload flags it", () => {
  const text = render("ORDER_DELIVERED", {
    buyer_language: "en",
    items: [{ name: "Netflix", qty: 1 }],
    masked_buyer_id: "WEB-buXXX",
    total: "40000",
    currency: "IDR",
    delivered_at: "2026-06-12 10:00 UTC",
    via_website: true,
  });
  expect(text).toContain("via Website");
});

it("omits the marker when the flag is absent", () => {
  const text = render("ORDER_DELIVERED", {
    buyer_language: "en",
    items: [],
    masked_buyer_id: "1234XXXX",
    total: "1",
    currency: "IDR",
    delivered_at: "x",
  });
  expect(text).not.toContain("via Website");
});
```

Run: `pnpm --filter @app/notifier test`
Expected: FAIL — first test (no marker rendered).

- [ ] **Step 2: Render the marker**

In `apps/notifier/src/templates.ts`, add `via_website?: unknown;` to `DeliveredPayload`, and in the `ORDER_DELIVERED` branch change the date line to include the marker:

```ts
    const viaWeb = payload.via_website ? `\n🌐 via Website` : "";
    return (
      `📢 <b>${s.title}</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `👤 ${s.buyer}: <code>${buyer}</code>\n` +
      `🛍️ ${s.products}:\n${itemsText}\n` +
      `💳 ${s.total}: <b>${total} ${currency}</b>\n` +
      `📅 ${s.date}: ${deliveredAt}${viaWeb}\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `${s.thanks}\n` +
      `━━━━━━━━━━━━━━━━━━`
    );
```

Run: `pnpm --filter @app/notifier test` — Expected: PASS.

- [ ] **Step 3: Masked buyer + flag in approveOrder**

In `packages/db/src/crud/orders.ts` replace lines 538-540 (masked id derivation) with:

```ts
  // Masked buyer for the public testimonial. Web-only accounts have no
  // telegramId — mask the login username instead and flag the source.
  const viaWebsite = order.user.telegramId == null;
  const rawId = viaWebsite
    ? `WEB-${(order.user.loginUsername ?? "user").slice(0, 2)}`
    : String(order.user.telegramId);
  const maskedBuyerId = rawId.slice(0, 4) + "X".repeat(Math.max(rawId.length - 4, 3));
```

and add to the `enqueueNotification(... ORDER_DELIVERED ...)` payload object:

```ts
    via_website: viaWebsite,
```

- [ ] **Step 4: Guard the TokoPay buyer DM**

In `packages/db/src/crud/tokopay.ts` wrap the `enqueueNotification(... ORDER_DELIVERED_DM ...)` call (lines 70-75):

```ts
      // Buyer DM via the outbox, same tx as the status flip — only when the
      // buyer HAS Telegram. Web-only buyers see the order on the website.
      if (delivered.user.telegramId != null) {
        await enqueueNotification(tx, NotificationEvent.ORDER_DELIVERED_DM, delivered.id, {
          chat_id: Number(delivered.user.telegramId),
          order_code: delivered.orderCode,
          order_url: args.shopUrl ? `${args.shopUrl.replace(/\/+$/, "")}/account/orders/${delivered.orderCode}` : null,
          buyer_language: langCode(delivered.user.language),
        });
      }
```

- [ ] **Step 5: Guard the Binance poller DM**

In `apps/order-bot/src/payments/binanceInternal.ts`, at the top of `onDelivered` (line 186):

```ts
async function onDelivered(api: Api, order: DeliveredOrder): Promise<void> {
  // Web-only buyer (no Telegram): nothing to DM — the order page shows it.
  if (order.user.telegramId == null) return;
  const lang = langCode(order.user.language);
  const tgId = Number(order.user.telegramId);
```

- [ ] **Step 6: Broadcasts only target users with Telegram**

In `packages/db/src/crud/broadcasts.ts` line 21:

```ts
  const base: Prisma.UserWhereInput = { banned: false, telegramId: { not: null } };
```

- [ ] **Step 7: Add a crud regression test**

Append to `packages/db/src/crud/broadcasts.test.ts` (same harness already in the file):

```ts
it("excludes web-only accounts (no telegramId) from every segment", async () => {
  await prisma.user.create({
    data: { telegramId: null, loginUsername: "webonly", email: "w@o.test", referralCode: "WEBONL" },
  });
  const all = await resolveSegmentRecipients(prisma, "ALL");
  expect(all.every((r) => r.telegramId !== null)).toBe(true);
});
```

(Import `resolveSegmentRecipients` if the file doesn't already.)

- [ ] **Step 8: Run the affected suites**

Run: `pnpm --filter @app/db test && pnpm --filter @app/notifier test && pnpm --filter @app/order-bot typecheck`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/db/src/crud/orders.ts packages/db/src/crud/tokopay.ts packages/db/src/crud/broadcasts.ts packages/db/src/crud/broadcasts.test.ts apps/order-bot/src/payments/binanceInternal.ts apps/notifier/src/templates.ts apps/notifier/src/templates.test.ts
git commit -m "feat(notif): skip Telegram for web-only buyers; via-Website testimonial marker"
```

---

### Task 11: Full verification + cosmetic web-admin fallback

**Files:**
- Modify (cosmetic): `apps/web-admin/views/user_detail.njk`, `apps/web-admin/views/users.njk` — wherever `{{ user.telegramId }}` / `{{ u.telegramId }}` is printed raw, change to `{{ user.telegramId or "—" }}` (pattern; locate with grep below)

- [ ] **Step 1: Cosmetic null fallback in web-admin views**

Run: `pnpm exec rg -n "telegramId" "apps/web-admin/views"` — for each template that PRINTS a telegram id (not ones using it in URLs/conditions), apply the `or "—"` fallback so web-only users render a dash instead of an empty cell.

- [ ] **Step 2: Full repo typecheck**

Run: `pnpm -r typecheck`
Expected: PASS across every workspace.

- [ ] **Step 3: Full test suite**

Run: `pnpm test`
Expected: PASS — all workspaces green.

- [ ] **Step 4: Commit + deploy note**

```bash
git add -A
git commit -m "chore: nullable-telegramId display fallback + full suite green for storefront password auth"
```

**Deploy reminder (CLAUDE.md “Schema change on deploy”):** on the live host run `pnpm prisma db push` against `data/bot.db` and restart the combined server BEFORE the new code serves traffic, or Prisma throws `P2022 column does not exist`. New env to set in production for forgot-password: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` (e.g. Hostinger SMTP). One-time side effect: every active storefront session logs out (jti re-key).

---

## Self-Review Notes

- Spec §1 schema → Task 1. §2 login → Task 6. §3 register → Task 7. §4 forgot/reset → Task 8. §5 settings/link → Task 9. §6 session/notifier/broadcast → Tasks 6+10. §7 security → woven through (generic errors, hashed tokens, csrfProtect on settings, anonymous POSTs SameSite-only per spec). §8 tests → every task.
- Type names consistent: `createWebUser`, `findUserByLoginIdentifier`, `setLoginCredentials`, `linkTelegram`, `createPasswordResetToken`, `consumePasswordResetToken`, `LOGIN_USERNAME_RE`, `establishSession`, `shopSessionJtiKey(userId)` — used identically across Tasks 3, 6–9.
- Known judgment calls the executor may adjust: `ui.flash` kind names; how the Nunjucks `t` filter takes placeholder args (Task 9 note); hoisting the inline `await import(...)`s in Task 7 to top-level imports.
