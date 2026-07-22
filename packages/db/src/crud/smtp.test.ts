import { describe, it, expect, beforeEach, vi } from "vitest";

const mockConfig = vi.hoisted(() => ({
  SMTP_HOST: undefined as string | undefined,
  SMTP_PORT: 587,
  SMTP_USER: undefined as string | undefined,
  SMTP_PASS: undefined as string | undefined,
  SMTP_FROM: undefined as string | undefined,
  SMTP_SECURE: false,
}));

vi.mock("@app/core/config", () => ({ config: mockConfig }));

import { getSmtpCreds } from "./smtp";
import type { Db } from "./_types";

/** In-memory Setting store as a Db stub (only `setting.findUnique` is used). */
function stubDb(values: Record<string, string>): Db {
  return {
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        values[where.key] != null ? { key: where.key, value: values[where.key] } : null,
    },
  } as unknown as Db;
}

beforeEach(() => {
  mockConfig.SMTP_HOST = undefined;
  mockConfig.SMTP_PORT = 587;
  mockConfig.SMTP_USER = undefined;
  mockConfig.SMTP_PASS = undefined;
  mockConfig.SMTP_FROM = undefined;
  mockConfig.SMTP_SECURE = false;
});

describe("getSmtpCreds", () => {
  it("returns null when nothing is configured (no host, no env fallback)", async () => {
    expect(await getSmtpCreds(stubDb({}))).toBeNull();
  });

  it("returns null when only host is set but from is blank", async () => {
    expect(await getSmtpCreds(stubDb({ smtp_host: "smtp.hostinger.com" }))).toBeNull();
  });

  it("resolves full creds from Settings when host and from are both set", async () => {
    const creds = await getSmtpCreds(
      stubDb({
        smtp_host: "smtp.hostinger.com",
        smtp_port: "465",
        smtp_user: "no-reply@trustance.id",
        smtp_pass: "@Ilhamalif65",
        smtp_from: "Trustance <no-reply@trustance.id>",
        smtp_secure: "true",
      }),
    );
    expect(creds).toEqual({
      host: "smtp.hostinger.com",
      port: 465,
      secure: true,
      user: "no-reply@trustance.id",
      pass: "@Ilhamalif65",
      from: "Trustance <no-reply@trustance.id>",
    });
  });

  it("falls back to env per-field when a Setting is blank", async () => {
    mockConfig.SMTP_HOST = "smtp.env-fallback.test";
    mockConfig.SMTP_PORT = 2525;
    mockConfig.SMTP_USER = "env-user";
    mockConfig.SMTP_PASS = "env-pass";
    mockConfig.SMTP_FROM = "Env <env@test.invalid>";
    mockConfig.SMTP_SECURE = true;

    const creds = await getSmtpCreds(stubDb({ smtp_host: "  " }));
    expect(creds).toEqual({
      host: "smtp.env-fallback.test",
      port: 2525,
      secure: true,
      user: "env-user",
      pass: "env-pass",
      from: "Env <env@test.invalid>",
    });
  });

  it("defaults port to 587 and secure to false when neither Setting nor env provides them", async () => {
    const creds = await getSmtpCreds(stubDb({ smtp_host: "smtp.example.com", smtp_from: "Shop <noreply@example.com>" }));
    expect(creds?.port).toBe(587);
    expect(creds?.secure).toBe(false);
  });

  it("ignores a non-numeric port Setting and falls back to the env/default port", async () => {
    const creds = await getSmtpCreds(
      stubDb({ smtp_host: "smtp.example.com", smtp_from: "Shop <noreply@example.com>", smtp_port: "not-a-number" }),
    );
    expect(creds?.port).toBe(587);
  });
});
