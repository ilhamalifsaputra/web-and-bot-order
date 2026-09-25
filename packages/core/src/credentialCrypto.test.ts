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
  LegacyPlaintextCredentialError,
  legacyPlaintextPassthroughCount,
  encryptDeliveredContent,
  decryptDeliveredContent,
  tryDecryptDeliveredContent,
  CredentialEnvelopeError,
  credentialEnvelopeWriteVersion,
  credentialEnvelopeVersion,
  stockCredentialsAad,
  deliveredContentAad,
  settingValueAad,
  encryptStockCredentials,
  decryptStockCredentials,
} from "./credentialCrypto";
import { logger } from "./logger";

const ORIGINAL_KEY = process.env.CREDENTIAL_ENCRYPTION_KEY;
// Any context: the envelopes these older tests write are v1 (the write flag is off by default), which ignores it.
const AAD = "test.context:1";

describe("credentialCrypto", () => {
  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    else process.env.CREDENTIAL_ENCRYPTION_KEY = ORIGINAL_KEY;
  });

  it("round-trips a plaintext credential through encrypt/decrypt", () => {
    const plaintext = "buyer@example.com:Sup3rSecret!";
    const stored = encryptCredentials(plaintext, AAD);
    expect(stored).not.toContain(plaintext);
    expect(decryptCredentials(stored)).toBe(plaintext);
  });

  it("stores a JSON envelope with keyVersion/iv/ciphertext/authTag", () => {
    const stored = encryptCredentials("a@b.com:pw", AAD);
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      keyVersion: 1,
      iv: expect.any(String),
      ciphertext: expect.any(String),
      authTag: expect.any(String),
    });
  });

  it("uses a fresh IV per call — the same plaintext encrypts to different ciphertext each time", () => {
    const a = encryptCredentials("same@value.com:pw", AAD);
    const b = encryptCredentials("same@value.com:pw", AAD);
    expect(a).not.toBe(b);
    expect(decryptCredentials(a)).toBe("same@value.com:pw");
    expect(decryptCredentials(b)).toBe("same@value.com:pw");
  });

  it("isEncryptedCredentialEnvelope recognizes an encrypted value and rejects plaintext", () => {
    const stored = encryptCredentials("a@b.com:pw", AAD);
    expect(isEncryptedCredentialEnvelope(stored)).toBe(true);
    expect(isEncryptedCredentialEnvelope("plain@text.com:pw")).toBe(false);
    expect(isEncryptedCredentialEnvelope("{}")).toBe(false);
    expect(isEncryptedCredentialEnvelope("not json at all")).toBe(false);
  });

  it("decryptCredentials passes through a legacy plaintext value unchanged (backward compat before backfill)", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      expect(decryptCredentials("legacy@plain.com:pw")).toBe("legacy@plain.com:pw");
    } finally {
      warn.mockRestore();
    }
  });

  it("throws a structural error (never the value) when the key is unconfigured", () => {
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    expect(() => encryptCredentials("a@b.com:pw", AAD)).toThrow(/CREDENTIAL_ENCRYPTION_KEY is not configured/);
  });

  it("throws when the configured key is not 32 bytes of hex", () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = "tooshort";
    expect(() => encryptCredentials("a@b.com:pw", AAD)).toThrow(/32 bytes/);
  });

  it("throws (does not silently mis-decrypt) when the stored envelope was encrypted under a different key", () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = "11".repeat(32);
    const stored = encryptCredentials("a@b.com:pw", AAD);
    process.env.CREDENTIAL_ENCRYPTION_KEY = "22".repeat(32);
    expect(() => decryptCredentials(stored)).toThrow();
  });

  it("throws on a tampered auth tag instead of returning corrupted plaintext", () => {
    const stored = encryptCredentials("a@b.com:pw", AAD);
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
    const stored = encryptCredentials("a@b.com:pw", AAD);
    expect(tryDecryptCredentials(stored, { stockItemId: 7, purpose: "test" })).toBe("a@b.com:pw");
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns null and warns with the row id (never the content) for a tampered envelope", () => {
    const envelope = JSON.parse(encryptCredentials("secret@b.com:Hunter2", AAD)) as { authTag: string };
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
    const stored = encryptCredentials("a@b.com:pw", AAD);
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    expect(() => tryDecryptCredentials(stored, { stockItemId: 1, purpose: "test" })).toThrow(CredentialKeyConfigError);
  });
});

describe("ALLOW_LEGACY_PLAINTEXT (Fase 6b — legacy plaintext passthrough flag)", () => {
  const ORIGINAL_FLAG = process.env.ALLOW_LEGACY_PLAINTEXT;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    if (ORIGINAL_FLAG === undefined) delete process.env.ALLOW_LEGACY_PLAINTEXT;
    else process.env.ALLOW_LEGACY_PLAINTEXT = ORIGINAL_FLAG;
  });

  it("defaults to permissive: unset passes a legacy plaintext row through and counts it", () => {
    delete process.env.ALLOW_LEGACY_PLAINTEXT;
    const before = legacyPlaintextPassthroughCount();
    expect(decryptCredentials("legacy@plain.com:pw")).toBe("legacy@plain.com:pw");
    expect(legacyPlaintextPassthroughCount()).toBe(before + 1);
  });

  it("warns exactly once per process, without the plaintext, however many legacy rows pass through", async () => {
    delete process.env.ALLOW_LEGACY_PLAINTEXT;
    // Fresh module instances, so the once-per-process state starts from zero.
    vi.resetModules();
    const fresh = await import("./credentialCrypto");
    const freshLogger = (await import("./logger")).logger;
    const freshWarn = vi.spyOn(freshLogger, "warn").mockImplementation(() => undefined);
    try {
      fresh.decryptCredentials("warn-me@plain.com:Hunter2");
      fresh.decryptCredentials("warn-me-again@plain.com:Hunter3");
      fresh.decryptCredentials("warn-me-thrice@plain.com:Hunter4");
      expect(freshWarn).toHaveBeenCalledTimes(1);
      expect(fresh.legacyPlaintextPassthroughCount()).toBe(3);
      expect(JSON.stringify(freshWarn.mock.calls)).not.toMatch(/Hunter|warn-me/);
    } finally {
      freshWarn.mockRestore();
    }
  });

  it.each(["true", "1", "yes", "on", "", "anything-else"])("stays permissive for %j", (value) => {
    process.env.ALLOW_LEGACY_PLAINTEXT = value;
    expect(decryptCredentials("legacy@plain.com:pw")).toBe("legacy@plain.com:pw");
  });

  it.each(["false", "0", "no", "off", " FALSE "])("refuses a legacy plaintext row in strict mode (%j)", (value) => {
    process.env.ALLOW_LEGACY_PLAINTEXT = value;
    expect(() => decryptCredentials("strict@plain.com:Hunter2")).toThrow(LegacyPlaintextCredentialError);
  });

  it("the strict-mode error never contains the stored value", () => {
    process.env.ALLOW_LEGACY_PLAINTEXT = "false";
    try {
      decryptCredentials("strict@plain.com:Hunter2");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain("Hunter2");
      expect((err as Error).message).not.toContain("strict@plain.com");
    }
  });

  it("strict mode also refuses JSON that is not an envelope", () => {
    process.env.ALLOW_LEGACY_PLAINTEXT = "false";
    expect(() => decryptCredentials('{"user":"a@b.com"}')).toThrow(LegacyPlaintextCredentialError);
  });

  it("strict mode still decrypts a real envelope and passes an empty value through", () => {
    process.env.ALLOW_LEGACY_PLAINTEXT = "false";
    expect(decryptCredentials(encryptCredentials("ok@b.com:pw", AAD))).toBe("ok@b.com:pw");
    expect(decryptCredentials("")).toBe("");
  });

  it("strict mode makes a display read skip the legacy row instead of failing", () => {
    process.env.ALLOW_LEGACY_PLAINTEXT = "false";
    expect(tryDecryptCredentials("strict@plain.com:pw", { stockItemId: 5, purpose: "test" })).toBeNull();
  });
});

describe("Order.deliveredContent helpers (Fase 6c)", () => {
  const ORIGINAL_FLAG = process.env.ALLOW_LEGACY_PLAINTEXT;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    if (ORIGINAL_FLAG === undefined) delete process.env.ALLOW_LEGACY_PLAINTEXT;
    else process.env.ALLOW_LEGACY_PLAINTEXT = ORIGINAL_FLAG;
    if (ORIGINAL_KEY === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    else process.env.CREDENTIAL_ENCRYPTION_KEY = ORIGINAL_KEY;
  });

  it("encryptDeliveredContent stores an envelope that decryptDeliveredContent reads back", () => {
    const stored = encryptDeliveredContent("user: acc1\npass: Hunter2", 1);
    expect(isEncryptedCredentialEnvelope(stored)).toBe(true);
    expect(stored).not.toContain("Hunter2");
    expect(decryptDeliveredContent(stored, 1)).toBe("user: acc1\npass: Hunter2");
  });

  it("decryptDeliveredContent keeps null as null (no content delivered yet)", () => {
    expect(decryptDeliveredContent(null, 1)).toBeNull();
  });

  it("decryptDeliveredContent passes a pre-encryption plaintext row through in permissive mode", () => {
    delete process.env.ALLOW_LEGACY_PLAINTEXT;
    expect(decryptDeliveredContent("SN-LEGACY-1", 1)).toBe("SN-LEGACY-1");
  });

  it("decryptDeliveredContent throws on a tampered envelope and on legacy plaintext in strict mode", () => {
    const envelope = JSON.parse(encryptDeliveredContent("SN-123", 1)) as { authTag: string };
    envelope.authTag = Buffer.from("0000000000000000", "hex").toString("base64");
    expect(() => decryptDeliveredContent(JSON.stringify(envelope), 1)).toThrow();
    process.env.ALLOW_LEGACY_PLAINTEXT = "false";
    expect(() => decryptDeliveredContent("SN-LEGACY-1", 1)).toThrow(LegacyPlaintextCredentialError);
  });

  it("tryDecryptDeliveredContent returns null and warns with the order id (never the content) for a tampered envelope", () => {
    const envelope = JSON.parse(encryptDeliveredContent("user:x pass:Hunter2", 1)) as { authTag: string; ciphertext: string };
    envelope.authTag = Buffer.from("0000000000000000", "hex").toString("base64");
    expect(tryDecryptDeliveredContent(JSON.stringify(envelope), { orderId: 314, purpose: "a buyer's order detail page" })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).toContain("314");
    expect(logged).not.toContain("Hunter2");
    expect(logged).not.toContain(envelope.ciphertext);
  });

  it("tryDecryptDeliveredContent reads a readable value (and null) without logging, and rethrows a key misconfiguration", () => {
    const stored = encryptDeliveredContent("SN-9", 1);
    expect(tryDecryptDeliveredContent(stored, { orderId: 1, purpose: "test" })).toBe("SN-9");
    expect(tryDecryptDeliveredContent(null, { orderId: 1, purpose: "test" })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    expect(() => tryDecryptDeliveredContent(stored, { orderId: 1, purpose: "test" })).toThrow(CredentialKeyConfigError);
  });
});

describe("envelope v2 with AAD (Fase 6d)", () => {
  const ORIGINAL_WRITE_V2 = process.env.CREDENTIAL_ENVELOPE_WRITE_V2;
  let warn: ReturnType<typeof vi.spyOn>;
  const setWriteV2 = (on: boolean) => {
    if (on) process.env.CREDENTIAL_ENVELOPE_WRITE_V2 = "true";
    else delete process.env.CREDENTIAL_ENVELOPE_WRITE_V2;
  };
  beforeEach(() => {
    warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    if (ORIGINAL_WRITE_V2 === undefined) delete process.env.CREDENTIAL_ENVELOPE_WRITE_V2;
    else process.env.CREDENTIAL_ENVELOPE_WRITE_V2 = ORIGINAL_WRITE_V2;
    if (ORIGINAL_KEY === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    else process.env.CREDENTIAL_ENCRYPTION_KEY = ORIGINAL_KEY;
  });

  describe("the write flag", () => {
    it("defaults to v1 when CREDENTIAL_ENVELOPE_WRITE_V2 is unset", () => {
      delete process.env.CREDENTIAL_ENVELOPE_WRITE_V2;
      expect(credentialEnvelopeWriteVersion()).toBe(1);
    });

    it.each(["true", "1", "yes", "on", " TRUE "])("writes v2 for %j", (value) => {
      process.env.CREDENTIAL_ENVELOPE_WRITE_V2 = value;
      expect(credentialEnvelopeWriteVersion()).toBe(2);
    });

    it.each(["", "false", "0", "no", "off", "v2", "anything-else"])("stays on v1 for %j", (value) => {
      process.env.CREDENTIAL_ENVELOPE_WRITE_V2 = value;
      expect(credentialEnvelopeWriteVersion()).toBe(1);
    });

    it("with the flag off, the stored envelope has exactly the pre-6d fields (no version marker)", () => {
      setWriteV2(false);
      const parsed = JSON.parse(encryptCredentials("a@b.com:pw", AAD)) as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual(["authTag", "ciphertext", "iv", "keyVersion"]);
      expect(credentialEnvelopeVersion(JSON.stringify(parsed))).toBe(1);
    });

    it("with the flag on, the stored envelope is marked v:2 and keeps key version 1", () => {
      setWriteV2(true);
      const parsed = JSON.parse(encryptCredentials("a@b.com:pw", AAD)) as Record<string, unknown>;
      expect(parsed).toMatchObject({ v: 2, keyVersion: 1 });
      expect(isEncryptedCredentialEnvelope(JSON.stringify(parsed))).toBe(true);
      expect(credentialEnvelopeVersion(JSON.stringify(parsed))).toBe(2);
    });
  });

  describe("context strings (changing one makes every v2 value written under it unreadable)", () => {
    it("are pinned exactly", () => {
      expect(stockCredentialsAad(12)).toBe("stock_items.credentials:12");
      expect(deliveredContentAad(5)).toBe("orders.delivered_content:5");
      expect(settingValueAad("smtp_pass")).toBe("settings.value:smtp_pass");
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("refuse a non-row id (%s)", (id) => {
      expect(() => stockCredentialsAad(id)).toThrow(CredentialEnvelopeError);
      expect(() => deliveredContentAad(id)).toThrow(CredentialEnvelopeError);
    });

    it("refuse an empty setting key", () => {
      expect(() => settingValueAad("")).toThrow(CredentialEnvelopeError);
    });
  });

  describe.each([false, true])("with CREDENTIAL_ENVELOPE_WRITE_V2 %s", (on) => {
    beforeEach(() => setWriteV2(on));

    it("round-trips under the same context", () => {
      const stored = encryptCredentials("buyer@example.com:Sup3r", "settings.value:smtp_pass");
      expect(stored).not.toContain("Sup3r");
      expect(decryptCredentials(stored, "settings.value:smtp_pass")).toBe("buyer@example.com:Sup3r");
    });

    it("refuses an empty context on write, whatever version it would write", () => {
      expect(() => encryptCredentials("a@b.com:pw", "")).toThrow(CredentialEnvelopeError);
    });

    it("round-trips the stock and delivered-content wrappers", () => {
      expect(decryptStockCredentials(encryptStockCredentials("s@x.com:pw", 7), 7)).toBe("s@x.com:pw");
      expect(decryptDeliveredContent(encryptDeliveredContent("SN-7", 7), 7)).toBe("SN-7");
      expect(tryDecryptCredentials(encryptStockCredentials("s@x.com:pw", 7), { stockItemId: 7, purpose: "test" })).toBe(
        "s@x.com:pw",
      );
      expect(tryDecryptDeliveredContent(encryptDeliveredContent("SN-7", 7), { orderId: 7, purpose: "test" })).toBe("SN-7");
      expect(warn).not.toHaveBeenCalled();
    });

    it("boot canary passes", () => {
      expect(() => assertCredentialKeyConfigured()).not.toThrow();
    });

    it("fingerprints depend on the plaintext only", () => {
      setWriteV2(false);
      const off = [computeCredentialFingerprint("fp@x.com:pw"), computeIdentityFingerprint("fp@x.com:pw")];
      setWriteV2(true);
      expect([computeCredentialFingerprint("fp@x.com:pw"), computeIdentityFingerprint("fp@x.com:pw")]).toEqual(off);
    });
  });

  describe("reading a v1 envelope", () => {
    beforeEach(() => setWriteV2(false));

    it("decrypts with no context, the right context or any other context", () => {
      const stored = encryptStockCredentials("v1@x.com:pw", 3);
      expect(decryptCredentials(stored)).toBe("v1@x.com:pw");
      expect(decryptStockCredentials(stored, 3)).toBe("v1@x.com:pw");
      expect(decryptStockCredentials(stored, 4)).toBe("v1@x.com:pw");
      expect(decryptDeliveredContent(stored, 3)).toBe("v1@x.com:pw");
    });

    it("cannot be passed off as v2 by adding the marker", () => {
      const envelope = JSON.parse(encryptStockCredentials("v1@x.com:pw", 3)) as Record<string, unknown>;
      envelope.v = 2;
      expect(() => decryptStockCredentials(JSON.stringify(envelope), 3)).toThrow(CredentialEnvelopeError);
    });
  });

  describe("reading a v2 envelope", () => {
    beforeEach(() => setWriteV2(true));

    it("still decrypts after the flag is turned back off (the rollback path)", () => {
      const stored = encryptStockCredentials("rollback@x.com:pw", 9);
      setWriteV2(false);
      expect(decryptStockCredentials(stored, 9)).toBe("rollback@x.com:pw");
    });

    it("refuses to decrypt without a context, with a non-secret error", () => {
      const stored = encryptStockCredentials("nocontext@x.com:Hunter2", 9);
      expect(() => decryptCredentials(stored)).toThrow(CredentialEnvelopeError);
      expect(() => decryptCredentials(stored, "")).toThrow(CredentialEnvelopeError);
      try {
        decryptCredentials(stored);
        expect.unreachable();
      } catch (err) {
        expect((err as Error).message).not.toMatch(/Hunter2|nocontext/);
      }
    });

    it("refuses another row's context, so a ciphertext copied between rows does not decrypt", () => {
      const stored = encryptStockCredentials("row9@x.com:Hunter2", 9);
      expect(() => decryptStockCredentials(stored, 10)).toThrow(CredentialEnvelopeError);
      try {
        decryptStockCredentials(stored, 10);
        expect.unreachable();
      } catch (err) {
        expect((err as Error).message).not.toMatch(/Hunter2|row9|stock_items/);
      }
    });

    it("refuses another column's context for the same id", () => {
      const stock = encryptStockCredentials("same-id@x.com:pw", 5);
      const delivered = encryptDeliveredContent("SN-5", 5);
      const setting = encryptCredentials("secret", settingValueAad("smtp_pass"));
      expect(() => decryptDeliveredContent(stock, 5)).toThrow(CredentialEnvelopeError);
      expect(() => decryptStockCredentials(delivered, 5)).toThrow(CredentialEnvelopeError);
      expect(() => decryptCredentials(setting, settingValueAad("tokopay_secret"))).toThrow(CredentialEnvelopeError);
    });

    it("cannot be downgraded to v1 by removing the marker", () => {
      const envelope = JSON.parse(encryptStockCredentials("downgrade@x.com:pw", 9)) as Record<string, unknown>;
      delete envelope.v;
      expect(() => decryptStockCredentials(JSON.stringify(envelope), 9)).toThrow();
      expect(() => decryptCredentials(JSON.stringify(envelope))).toThrow();
    });

    it("is refused under a different key", () => {
      process.env.CREDENTIAL_ENCRYPTION_KEY = "11".repeat(32);
      const stored = encryptStockCredentials("key@x.com:pw", 9);
      process.env.CREDENTIAL_ENCRYPTION_KEY = "22".repeat(32);
      expect(() => decryptStockCredentials(stored, 9)).toThrow(CredentialEnvelopeError);
    });

    it("display reads turn a wrong-context value into null plus a warning, never the content", () => {
      const stock = encryptStockCredentials("display@x.com:Hunter2", 9);
      expect(tryDecryptCredentials(stock, { stockItemId: 10, purpose: "test" })).toBeNull();
      const delivered = encryptDeliveredContent("SN-Hunter2", 9);
      expect(tryDecryptDeliveredContent(delivered, { orderId: 10, purpose: "test" })).toBeNull();
      expect(warn).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/Hunter2|display@/);
    });
  });

  it.each([3, "2", 0, null])("refuses an unknown envelope version %j instead of treating it as plaintext", (v) => {
    setWriteV2(false);
    const envelope = JSON.parse(encryptCredentials("a@b.com:pw", AAD)) as Record<string, unknown>;
    envelope.v = v;
    expect(() => decryptCredentials(JSON.stringify(envelope), AAD)).toThrow(CredentialEnvelopeError);
  });

  it("credentialEnvelopeVersion is null for anything that is not an envelope", () => {
    expect(credentialEnvelopeVersion("plain@x.com:pw")).toBeNull();
    expect(credentialEnvelopeVersion("")).toBeNull();
    expect(credentialEnvelopeVersion('{"user":"a"}')).toBeNull();
  });
});
