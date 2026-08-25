import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  encryptCredentials,
  decryptCredentials,
  isEncryptedCredentialEnvelope,
} from "./credentialCrypto";

const ORIGINAL_KEY = process.env.CREDENTIAL_ENCRYPTION_KEY;

describe("credentialCrypto", () => {
  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    else process.env.CREDENTIAL_ENCRYPTION_KEY = ORIGINAL_KEY;
  });

  it("round-trips a plaintext credential through encrypt/decrypt", () => {
    const plaintext = "buyer@example.com:Sup3rSecret!";
    const stored = encryptCredentials(plaintext);
    expect(stored).not.toContain(plaintext);
    expect(decryptCredentials(stored)).toBe(plaintext);
  });

  it("stores a JSON envelope with keyVersion/iv/ciphertext/authTag", () => {
    const stored = encryptCredentials("a@b.com:pw");
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      keyVersion: 1,
      iv: expect.any(String),
      ciphertext: expect.any(String),
      authTag: expect.any(String),
    });
  });

  it("uses a fresh IV per call — the same plaintext encrypts to different ciphertext each time", () => {
    const a = encryptCredentials("same@value.com:pw");
    const b = encryptCredentials("same@value.com:pw");
    expect(a).not.toBe(b);
    expect(decryptCredentials(a)).toBe("same@value.com:pw");
    expect(decryptCredentials(b)).toBe("same@value.com:pw");
  });

  it("isEncryptedCredentialEnvelope recognizes an encrypted value and rejects plaintext", () => {
    const stored = encryptCredentials("a@b.com:pw");
    expect(isEncryptedCredentialEnvelope(stored)).toBe(true);
    expect(isEncryptedCredentialEnvelope("plain@text.com:pw")).toBe(false);
    expect(isEncryptedCredentialEnvelope("{}")).toBe(false);
    expect(isEncryptedCredentialEnvelope("not json at all")).toBe(false);
  });

  it("decryptCredentials passes through a legacy plaintext value unchanged (backward compat before backfill)", () => {
    expect(decryptCredentials("legacy@plain.com:pw")).toBe("legacy@plain.com:pw");
  });

  it("throws a structural error (never the value) when the key is unconfigured", () => {
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    expect(() => encryptCredentials("a@b.com:pw")).toThrow(/CREDENTIAL_ENCRYPTION_KEY is not configured/);
  });

  it("throws when the configured key is not 32 bytes of hex", () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = "tooshort";
    expect(() => encryptCredentials("a@b.com:pw")).toThrow(/32 bytes/);
  });

  it("throws (does not silently mis-decrypt) when the stored envelope was encrypted under a different key", () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = "11".repeat(32);
    const stored = encryptCredentials("a@b.com:pw");
    process.env.CREDENTIAL_ENCRYPTION_KEY = "22".repeat(32);
    expect(() => decryptCredentials(stored)).toThrow();
  });

  it("throws on a tampered auth tag instead of returning corrupted plaintext", () => {
    const stored = encryptCredentials("a@b.com:pw");
    const envelope = JSON.parse(stored) as { authTag: string };
    envelope.authTag = Buffer.from("0000000000000000", "hex").toString("base64");
    expect(() => decryptCredentials(JSON.stringify(envelope))).toThrow();
  });
});
