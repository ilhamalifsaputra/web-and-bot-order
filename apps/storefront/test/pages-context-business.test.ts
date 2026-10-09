// GET /api/v1/pages/context — owner-edited business identity and the
// payment-method display flags the footer reads.
import "./setup-env"; // FIRST import — sets env before @app/* load
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma, initDb, setSetting } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { buildApp } from "../src/server";

let app: FastifyInstance;

beforeAll(async () => {
  await initDb();
  app = await buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb(prisma);
  await setSetting(prisma, "setup_completed", "true");
});

async function context(): Promise<Record<string, any>> {
  const res = await app.inject({ method: "GET", url: "/api/v1/pages/context" });
  expect(res.statusCode).toBe(200);
  return res.json();
}

const setTokopay = async () => {
  await setSetting(prisma, "tokopay_merchant_id", "M1");
  await setSetting(prisma, "tokopay_secret", "s");
};
const setPaydisini = async () => {
  await setSetting(prisma, "paydisini_userkey", "u");
  await setSetting(prisma, "paydisini_apikey", "a");
};
const setXendit = async (qris: boolean, card: boolean) => {
  await setSetting(prisma, "xendit_secret_key", "xnd_development_k");
  await setSetting(prisma, "xendit_callback_token", "tok");
  await setSetting(prisma, "xendit_qris_enabled", String(qris));
  await setSetting(prisma, "xendit_card_enabled", String(card));
};

describe("GET /api/v1/pages/context — business", () => {
  it("every business field is null when nothing is set", async () => {
    expect((await context()).business).toEqual({
      legal_name: null,
      address: null,
      phone: null,
      email: null,
      hours: null,
    });
  });

  it("returns trimmed values when set, and null for blank ones", async () => {
    await setSetting(prisma, "business_legal_name", "  PT Contoh Usaha ");
    await setSetting(prisma, "business_address", "Jl. Contoh 1\nJakarta");
    await setSetting(prisma, "business_phone", "+62 21 555");
    await setSetting(prisma, "business_email", "cs@example.com");
    await setSetting(prisma, "business_hours", "   ");
    expect((await context()).business).toEqual({
      legal_name: "PT Contoh Usaha",
      address: "Jl. Contoh 1\nJakarta",
      phone: "+62 21 555",
      email: "cs@example.com",
      hours: null,
    });
  });
});

describe("GET /api/v1/pages/context — pay_methods", () => {
  it("both false with no gateway configured", async () => {
    expect((await context()).pay_methods).toEqual({ qris: false, card: false });
  });

  it("TokoPay alone enables qris", async () => {
    await setTokopay();
    expect((await context()).pay_methods).toEqual({ qris: true, card: false });
  });

  it("PayDisini alone enables qris", async () => {
    await setPaydisini();
    expect((await context()).pay_methods).toEqual({ qris: true, card: false });
  });

  it("Xendit with only QRIS enabled", async () => {
    await setXendit(true, false);
    expect((await context()).pay_methods).toEqual({ qris: true, card: false });
  });

  it("Xendit with only card enabled", async () => {
    await setXendit(false, true);
    expect((await context()).pay_methods).toEqual({ qris: false, card: true });
  });

  it("Xendit with both enabled", async () => {
    await setXendit(true, true);
    expect((await context()).pay_methods).toEqual({ qris: true, card: true });
  });

  it("Xendit switched off hides both flags", async () => {
    await setXendit(true, true);
    await setSetting(prisma, "xendit_enabled", "false");
    expect((await context()).pay_methods).toEqual({ qris: false, card: false });
  });

  it("TokoPay plus Xendit card-only keeps both flags true", async () => {
    await setTokopay();
    await setXendit(false, true);
    expect((await context()).pay_methods).toEqual({ qris: true, card: true });
  });

  it("stays 200 with correct flags when a Xendit secret cannot be decrypted", async () => {
    await setXendit(true, true);
    await setSetting(prisma, "xendit_secret_key", '{"keyVersion":1,"iv":"x","ciphertext":"x","authTag":"x"}');
    expect((await context()).pay_methods).toEqual({ qris: true, card: true });
  });
});
