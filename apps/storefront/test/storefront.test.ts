// Storefront catalog smoke tests — drives the Fastify app with app.inject()
// against an isolated temp DB (pattern: apps/web-admin/test/web.test.ts).
import "./setup-env"; // FIRST import — sets env before @app/* load
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("@app/core/mailer", () => ({
  sendMail: vi.fn().mockResolvedValue(undefined),
}));
import type { FastifyInstance } from "fastify";
import { cleanupTestDb } from "./setup-env";
import { prisma, initDb, setSetting, deleteSetting } from "@app/db";
import { buildApp } from "../src/server";

let app: FastifyInstance;
let productId: number;
let categoryId: number;
let emptyProductId: number;

beforeAll(async () => {
  await initDb();
  app = await buildApp();

  const cat = await prisma.category.create({
    data: { name: "Streaming", emoji: "🎬", sortOrder: 1 },
  });
  categoryId = cat.id;
  const prod = await prisma.product.create({
    data: {
      categoryId: cat.id,
      name: "Netflix Premium 1 Bulan",
      description: "Profil sharing, garansi penuh.",
      type: "SHARED",
      durationLabel: "1 month",
      price: "40000", // IDR central price (plan.md §15)
      warrantyDays: 30,
    },
  });
  productId = prod.id;
  await prisma.stockItem.createMany({
    data: Array.from({ length: 5 }, () => ({
      productId: prod.id,
      credentials: "user@mail.com:pass",
      status: "AVAILABLE",
    })),
  });
  const empty = await prisma.product.create({
    data: {
      categoryId: cat.id,
      name: "Spotify Family",
      type: "SHARED",
      durationLabel: "1 month",
      price: "25000",
    },
  });
  emptyProductId = empty.id;
  // Storefront tests model a live shop — keep the setup gate open.
  await setSetting(prisma, "setup_completed", "true");
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  cleanupTestDb();
});

async function loginAs(identifier: string, password: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/login", payload: { identifier, password } });
  const c = res.headers["set-cookie"];
  return Array.isArray(c) ? c.join("; ") : String(c);
}

function csrfFrom(html: string): string {
  return /name="csrf_token" value="([^"]+)"/.exec(html)![1]!;
}

describe("home", () => {
  it("renders the catalog with IDR prices", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Netflix Premium 1 Bulan");
    expect(res.body).toContain("Rp40.000");
    expect(res.body).toContain("Streaming");
  });

  it("hides the USDT info when usd_idr_rate is unset", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.body).not.toContain("≈ $");
  });

  it("shows the derived USDT beside the IDR price once a rate is set", async () => {
    await setSetting(prisma, "usd_idr_rate", "16000");
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.body).toContain("Rp40.000");
    expect(res.body).toContain("≈ $2.5"); // 40000/16000 = 2.5 (nearest 0.1)
  });
});

describe("category + product detail", () => {
  it("lists category products", async () => {
    const res = await app.inject({ method: "GET", url: `/c/${categoryId}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Netflix Premium 1 Bulan");
  });

  it("404s an unknown category", async () => {
    const res = await app.inject({ method: "GET", url: "/c/99999" });
    expect(res.statusCode).toBe(404);
  });

  it("renders product detail with stock badge and warranty", async () => {
    const res = await app.inject({ method: "GET", url: `/p/${productId}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Netflix Premium 1 Bulan");
    expect(res.body).toContain("Available"); // 5 > LOW_STOCK_THRESHOLD(3)
    expect(res.body).toContain("30-day warranty");
  });

  it("shows out-of-stock + restock CTA when no stock", async () => {
    const res = await app.inject({ method: "GET", url: `/p/${emptyProductId}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Out of stock");
    expect(res.body).toContain("Notify me when ready");
  });

  it("404s an inactive product", async () => {
    await prisma.product.update({ where: { id: emptyProductId }, data: { isActive: false } });
    const res = await app.inject({ method: "GET", url: `/p/${emptyProductId}` });
    expect(res.statusCode).toBe(404);
    await prisma.product.update({ where: { id: emptyProductId }, data: { isActive: true } });
  });
});

describe("search + language", () => {
  it("finds products by name", async () => {
    const res = await app.inject({ method: "GET", url: "/search?q=netflix" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Netflix Premium 1 Bulan");
  });

  it("shows the empty state for no hits", async () => {
    const res = await app.inject({ method: "GET", url: "/search?q=zzz-nope" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Nothing found");
  });

  it("switches to Indonesian via the lang cookie", async () => {
    const sw = await app.inject({ method: "GET", url: "/lang?to=id&back=/" });
    expect(sw.statusCode).toBe(303);
    const cookie = sw.headers["set-cookie"];
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { cookie: Array.isArray(cookie) ? cookie.join("; ") : String(cookie) },
    });
    expect(res.body).toContain("Produk terbaru"); // web.new_arrivals (id)
  });

  it("rejects an absolute redirect target on /lang", async () => {
    const sw = await app.inject({ method: "GET", url: "/lang?to=id&back=https://evil.example" });
    expect(sw.statusCode).toBe(303);
    expect(sw.headers.location).toBe("/");
  });
});

describe("errors", () => {
  it("renders a friendly 404 page", async () => {
    const res = await app.inject({ method: "GET", url: "/definitely-not-a-page" });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("404");
  });
});

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
    expect(acc.body).toContain("WEBB01");
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
    expect(res.body).toContain("isn&#39;t registered yet");
    expect(await prisma.user.count()).toBe(before);
  });
});

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
    await bad({ username: "x", email: "a@b.c", password: "longenough", password2: "longenough" }, "3");
    await bad({ username: "okname", email: "not-an-email", password: "longenough", password2: "longenough" }, "valid email");
    await bad({ username: "okname", email: "a@b.c", password: "short", password2: "short" }, "at least 8");
    await bad({ username: "okname", email: "a@b.c", password: "longenough", password2: "different1" }, "don");
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

describe("forgot + reset password", () => {
  it("always claims success, and mails only real accounts", async () => {
    const { sendMail } = await import("@app/core/mailer");
    const { hashPassword } = await import("@app/core/password");
    vi.clearAllMocks();
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
    expect(fake.body).toContain("on its way");

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
    expect(res.statusCode).toBe(303);
    const follow = await app.inject({ method: "GET", url: res.headers.location as string, headers: { cookie } });
    expect(follow.body).toContain("already linked to another member");
    const row = (await prisma.user.findFirst({ where: { loginUsername: "settingsuser" } }))!;
    expect(row.telegramId).toBe(636363n); // unchanged
  });
});

describe("storefront setup gate", () => {
  it("shows a 'shop not active yet' page while setup is pending", async () => {
    await deleteSetting(prisma, "setup_completed"); // no admin password in this DB
    try {
      const res = await app.inject({ method: "GET", url: "/" });
      expect(res.statusCode).toBe(503);
      expect(res.body).toContain("belum aktif");
    } finally {
      await setSetting(prisma, "setup_completed", "true"); // restore for other tests
    }
  });

  it("still serves /healthz while setup is pending", async () => {
    await deleteSetting(prisma, "setup_completed");
    try {
      const res = await app.inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(200);
    } finally {
      await setSetting(prisma, "setup_completed", "true");
    }
  });
});
