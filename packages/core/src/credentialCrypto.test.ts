import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { hkdfSync } from "node:crypto";
import {
  encryptCredentials,
  decryptCredentials,
  isEncryptedCredentialEnvelope,
  deriveCredentialIndexKey,
  normalizeIdentity,
  normalizeCredential,
  computeIdentityFingerprint,
  computeCredentialFingerprint,
  CredentialKeyConfigError,
  assertCredentialKeyConfigured,
  tryDecryptCredentials,
} from "./credentialCrypto";
import { logger } from "./logger";

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

describe("credential fingerprints (Fase 2 — stock traceability hardening)", () => {
  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    else process.env.CREDENTIAL_ENCRYPTION_KEY = ORIGINAL_KEY;
  });

  it("normalizeIdentity lowercases the email segment when it comes first", () => {
    expect(normalizeIdentity("User@Example.com:MyPw123")).toBe("user@example.com");
  });

  it("normalizeIdentity finds the email segment even when it isn't first", () => {
    expect(normalizeIdentity("MyPw123|User@Example.com")).toBe("user@example.com");
  });

  it("normalizeCredential lowercases only the email segment, preserving password case", () => {
    expect(normalizeCredential("User@Example.com:MyPw123")).toBe("user@example.com:MyPw123");
  });

  it("normalizeCredential trims and collapses whitespace in each segment", () => {
    expect(normalizeCredential("  User@Example.com  :  MyPw123  ")).toBe("user@example.com:MyPw123");
  });

  it("normalizeCredential never lowercases a password that happens to contain '@'", () => {
    expect(normalizeCredential("User@Example.com:P@ssWord")).toBe("user@example.com:P@ssWord");
    expect(computeCredentialFingerprint("a@b.com:P@ss")).not.toBe(computeCredentialFingerprint("a@b.com:p@ss"));
  });

  it("normalizeIdentity uses the first segment when no segment contains '@', so identity and credential fingerprints differ", () => {
    expect(normalizeIdentity("  SomeUser :pass")).toBe("SomeUser");
    expect(normalizeIdentity("SomeUser|pass|extra")).toBe("SomeUser");
    expect(computeIdentityFingerprint("user:pass")).not.toBe(computeCredentialFingerprint("user:pass"));
    expect(computeIdentityFingerprint("user:pass")).toBe(computeIdentityFingerprint("user:other"));
  });

  it("normalizeIdentity uses the whole trimmed string for a single-segment credential", () => {
    expect(normalizeIdentity("  LicenseKey-ABC  ")).toBe("LicenseKey-ABC");
  });

  it("only an '@' identity is case-insensitive; a no-'@' identity and a single-segment code keep their case", () => {
    expect(computeIdentityFingerprint("User@X.com:a")).toBe(computeIdentityFingerprint("user@x.com:b"));
    expect(computeCredentialFingerprint("User@X.com:pw")).toBe(computeCredentialFingerprint("user@x.com:pw"));
    expect(computeIdentityFingerprint("User:a")).not.toBe(computeIdentityFingerprint("user:a"));
    expect(computeCredentialFingerprint("User:pw")).not.toBe(computeCredentialFingerprint("user:pw"));
    expect(computeCredentialFingerprint("SteamCode-ABC")).not.toBe(computeCredentialFingerprint("steamcode-abc"));
    expect(computeCredentialFingerprint(" SteamCode-ABC ")).toBe(computeCredentialFingerprint("SteamCode-ABC"));
  });

  it("normalizeCredential leaves password whitespace and inner '|' untouched", () => {
    expect(normalizeCredential("a@b.com:pa  ss")).toBe("a@b.com:pa  ss");
    expect(computeCredentialFingerprint("a@b.com:pa  ss")).not.toBe(computeCredentialFingerprint("a@b.com:pa ss"));
    expect(normalizeCredential("a@b.com:pa|ss")).toBe("a@b.com:pa|ss");
    expect(computeCredentialFingerprint("a@b.com:pa|ss")).not.toBe(computeCredentialFingerprint("a@b.com:pa:ss"));
  });

  it("normalizeCredential collapses whitespace inside an e-mail identity segment only", () => {
    expect(normalizeCredential(" Some  User@X.com :x  y")).toBe("some user@x.com:x  y");
    expect(normalizeCredential(" Some  User :x  y")).toBe("Some  User:x  y");
  });

  it("normalizeCredential is delimiter-independent (':' and '|' normalize identically)", () => {
    expect(normalizeCredential("a@b.com|pw")).toBe(normalizeCredential("a@b.com:pw"));
  });

  it("computeCredentialFingerprint is deterministic and differs for different passwords with the same email", () => {
    const a1 = computeCredentialFingerprint("same@x.com:pw1");
    const a2 = computeCredentialFingerprint("same@x.com:pw1");
    const b = computeCredentialFingerprint("same@x.com:pw2");
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it("computeIdentityFingerprint matches across different passwords for the same email, while computeCredentialFingerprint differs", () => {
    const credA = "same@x.com:pw1";
    const credB = "same@x.com:pw2";
    expect(computeIdentityFingerprint(credA)).toBe(computeIdentityFingerprint(credB));
    expect(computeCredentialFingerprint(credA)).not.toBe(computeCredentialFingerprint(credB));
  });

  it("deriveCredentialIndexKey is cryptographically distinct from the raw AES key material, though both derive from the same env var", () => {
    // The fixed test key from vitest.config.ts/playwright.config.ts.
    const rawKeyHex = "00".repeat(32);
    process.env.CREDENTIAL_ENCRYPTION_KEY = rawKeyHex;
    const rawAesKey = Buffer.from(rawKeyHex, "hex");

    const indexKey = deriveCredentialIndexKey();
    expect(indexKey.equals(rawAesKey)).toBe(false);

    // Independently recompute via Node's hkdfSync using the same env var and
    // the documented info string, to pin down the exact derivation (not just
    // "it isn't the raw key").
    const expected = Buffer.from(
      hkdfSync("sha256", rawAesKey, Buffer.alloc(0), Buffer.from("trustance/credential-index/v1", "utf8"), 32),
    );
    expect(indexKey.equals(expected)).toBe(true);
  });

  it("deriveCredentialIndexKey throws CredentialKeyConfigError when CREDENTIAL_ENCRYPTION_KEY is unset", () => {
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    expect(() => deriveCredentialIndexKey()).toThrow(CredentialKeyConfigError);
    expect(() => deriveCredentialIndexKey()).toThrow(/CREDENTIAL_ENCRYPTION_KEY is not configured/);
  });
});

describe("assertCredentialKeyConfigured (Fase 6a — boot-time key check)", () => {
  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    else process.env.CREDENTIAL_ENCRYPTION_KEY = ORIGINAL_KEY;
  });

  it("passes silently when a valid 32-byte hex key is configured", () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = "ab".repeat(32);
    expect(() => assertCredentialKeyConfigured()).not.toThrow();
  });

  it("throws CredentialKeyConfigError when the key is unset", () => {
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    expect(() => assertCredentialKeyConfigured()).toThrow(CredentialKeyConfigError);
  });

  it("throws CredentialKeyConfigError when the key has the wrong length", () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = "ab".repeat(16);
    expect(() => assertCredentialKeyConfigured()).toThrow(CredentialKeyConfigError);
  });

  it("throws CredentialKeyConfigError when the key is 64 characters but not hex", () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = "zz".repeat(32);
    expect(() => assertCredentialKeyConfigured()).toThrow(CredentialKeyConfigError);
  });

  it("never puts the key material in the error message", () => {
    const bad = "ab".repeat(20);
    process.env.CREDENTIAL_ENCRYPTION_KEY = bad;
    try {
      assertCredentialKeyConfigured();
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain(bad);
    }
  });
});

describe("tryDecryptCredentials (Fase 6a — guarded decrypt for display paths)", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    if (ORIGINAL_KEY === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    else process.env.CREDENTIAL_ENCRYPTION_KEY = ORIGINAL_KEY;
  });

  it("returns the plaintext of a readable envelope without logging", () => {
    const stored = encryptCredentials("a@b.com:pw");
    expect(tryDecryptCredentials(stored, { stockItemId: 7, purpose: "test" })).toBe("a@b.com:pw");
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns null and warns with the row id (never the content) for a tampered envelope", () => {
    const envelope = JSON.parse(encryptCredentials("secret@b.com:Hunter2")) as { authTag: string };
    envelope.authTag = Buffer.from("0000000000000000", "hex").toString("base64");
    const stored = JSON.stringify(envelope);
    expect(tryDecryptCredentials(stored, { stockItemId: 42, purpose: "the admin stock search" })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).toContain("42");
    expect(logged).not.toContain("Hunter2");
    expect(logged).not.toContain(envelope.authTag);
    expect(logged).not.toContain((JSON.parse(stored) as { ciphertext: string }).ciphertext);
  });

  it("rethrows CredentialKeyConfigError instead of hiding a misconfigured key", () => {
    const stored = encryptCredentials("a@b.com:pw");
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    expect(() => tryDecryptCredentials(stored, { stockItemId: 1, purpose: "test" })).toThrow(CredentialKeyConfigError);
  });
});
