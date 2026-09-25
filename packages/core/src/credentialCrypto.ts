/**
 * Application-level encryption at rest for `StockItem.credentials` (Task 2,
 * Trustance Master Architecture Phase 1). AES-256-GCM, key sourced from the
 * `CREDENTIAL_ENCRYPTION_KEY` env var, versioned for future rotation.
 *
 * Storage shape: this repo already has a JSON-in-string convention for a
 * single TEXT column carrying structured data (`NotificationOutbox.payloadJson`,
 * `Denomination.additionalFields` — see schema.prisma's own comment pointing
 * at NotificationOutbox as the precedent). `StockItem.credentials` follows the
 * same convention rather than adding new columns: the stored string is a
 * JSON envelope `{ keyVersion, iv, ciphertext, authTag }`, all three binary
 * fields base64-encoded.
 *
 * NEVER log the plaintext, the stored envelope, or the key anywhere in this
 * file — including error messages, which must stay structural ("missing
 * field X") and never interpolate the value under (de/en)cryption.
 */
import { createCipheriv, createDecipheriv, randomBytes, hkdfSync, createHmac } from "node:crypto";
// Read directly from process.env rather than the validated `config` singleton
// (@app/core/config): `config` is parsed once at module import time, which
// would make the key impossible to vary between tests (see password.ts's
// identical BCRYPT_COST pattern, for the same testability reason — that one
// isn't in the Env schema either). dotenv (config.ts's own import) already
// loads the root .env before this runs, so a `.env`-only key still resolves.
import "./config";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12; // NIST-recommended GCM IV length.
const KEY_LENGTH_BYTES = 32; // AES-256.

/** Bumped only when a new `CREDENTIAL_ENCRYPTION_KEY` generation is
 * introduced (rotation) — see `keyForVersion` below for how a future
 * version's key would be looked up. Today there is exactly one key. */
const CURRENT_KEY_VERSION = 1;

export interface CredentialEnvelope {
  keyVersion: number;
  iv: string; // base64
  ciphertext: string; // base64
  authTag: string; // base64
}

/**
 * Raised by `keyForVersion` whenever `CREDENTIAL_ENCRYPTION_KEY` is missing,
 * malformed, or doesn't cover the requested key version — i.e. an operator
 * configuration problem, not a data-integrity one (a tampered/mis-keyed
 * envelope still throws a plain `Error` from `decryptCredentials`'s
 * `decipher.final()`). Callers that want to turn "encryption isn't
 * configured" into a clear operator-facing response (rather than falling
 * through to a generic 500) should catch this specific class — see
 * apps/web-admin/src/routes/api/stock.ts's bulk-add and reveal routes.
 */
export class CredentialKeyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialKeyConfigError";
  }
}

/** Resolve the raw AES-256 key bytes for a given envelope key version.
 * Throws (never logs the key material) if unconfigured, malformed, or the
 * requested version has no known key — the last case only matters once a
 * second key generation exists, which isn't wired up yet. */
function keyForVersion(version: number): Buffer {
  if (version !== CURRENT_KEY_VERSION) {
    throw new CredentialKeyConfigError(
      `No decryption key is configured for credential key version ${version} (current version is ${CURRENT_KEY_VERSION}).`,
    );
  }
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!raw) {
    throw new CredentialKeyConfigError(
      "CREDENTIAL_ENCRYPTION_KEY is not configured — cannot encrypt or decrypt stock item credentials. Set it in .env (see .env.example).",
    );
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw, "hex");
  } catch {
    throw new CredentialKeyConfigError("CREDENTIAL_ENCRYPTION_KEY is not valid hex.");
  }
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new CredentialKeyConfigError(
      `CREDENTIAL_ENCRYPTION_KEY must decode to exactly ${KEY_LENGTH_BYTES} bytes (${KEY_LENGTH_BYTES * 2} hex characters) for AES-256-GCM.`,
    );
  }
  return key;
}

/** Encrypt a plaintext credential string into the JSON envelope stored in
 * `StockItem.credentials`. Fresh random IV per call (AES-GCM requires a
 * unique IV per key — reuse would leak plaintext). */
export function encryptCredentials(plaintext: string): string {
  const key = keyForVersion(CURRENT_KEY_VERSION);
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const envelope: CredentialEnvelope = {
    keyVersion: CURRENT_KEY_VERSION,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: authTag.toString("base64"),
  };
  return JSON.stringify(envelope);
}

/** Structural check only (shape, not cryptographic validity) — used by the
 * backfill script to skip rows already migrated, and safe to call on
 * arbitrary stored strings. */
export function isEncryptedCredentialEnvelope(stored: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return false;
  }
  return isEnvelopeShape(parsed);
}

function isEnvelopeShape(value: unknown): value is CredentialEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.keyVersion === "number" &&
    typeof v.iv === "string" &&
    typeof v.ciphertext === "string" &&
    typeof v.authTag === "string"
  );
}

/**
 * Decrypt a stored `StockItem.credentials` value back to plaintext.
 *
 * Backward-compat fallback: a value that isn't valid JSON, or doesn't match
 * the envelope shape, is treated as a pre-encryption legacy plaintext row
 * (one the one-time backfill script hasn't reached yet, or a test fixture
 * that writes the column directly) and returned unchanged — this repo's
 * established pattern for tolerating rows that predate a schema/format
 * change (see OrderItem.deliveryTypeSnapshot's null-fallback in
 * schema.prisma) rather than crashing every read path on stale data.
 *
 * A value that DOES look like an envelope but fails to decrypt (wrong key,
 * corrupted ciphertext, tampered auth tag) still throws — that's a real
 * integrity problem, not a legacy row, and must not be silently swallowed.
 */
export function decryptCredentials(stored: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return stored;
  }
  if (!isEnvelopeShape(parsed)) return stored;

  const key = keyForVersion(parsed.keyVersion);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(parsed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(parsed.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(parsed.ciphertext, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

// ── Stock traceability hardening plan, Fase 2 ──────────────────────────────
// identityFingerprint/credentialFingerprint (StockItem, Fase 1 schema) are
// keyed HMACs so DB read access alone can never confirm a guessed credential
// offline (see schema.prisma's comment on those columns). The HMAC key is
// derived via HKDF from the SAME CREDENTIAL_ENCRYPTION_KEY material used for
// AES-GCM above, but cryptographically separated from it by a distinct HKDF
// `info` string — this index key can never be reused to decrypt a
// credentials envelope, and the AES key can never be reused to forge a
// fingerprint.

const INDEX_KEY_LENGTH_BYTES = 32;
const INDEX_KEY_INFO = "trustance/credential-index/v1";

/**
 * Derives a 32-byte key for computing keyed HMAC fingerprints
 * (identityFingerprint/credentialFingerprint on StockItem), via HKDF from
 * the SAME `CREDENTIAL_ENCRYPTION_KEY` material used for AES-GCM — but
 * cryptographically separated from it by a distinct HKDF `info` string, so
 * this index key can never be reused to decrypt a credentials envelope (and
 * vice versa). Deliberately does NOT feed into `keyForVersion`/AES at all;
 * this is purely for the HMAC fingerprint use case.
 */
export function deriveCredentialIndexKey(): Buffer {
  // Rotating CREDENTIAL_ENCRYPTION_KEY changes this key and orphans every stored fingerprint (re-run the backfill).
  const masterKey = keyForVersion(CURRENT_KEY_VERSION);
  return Buffer.from(
    hkdfSync("sha256", masterKey, Buffer.alloc(0), Buffer.from(INDEX_KEY_INFO, "utf8"), INDEX_KEY_LENGTH_BYTES),
  );
}

/** Splits a stock credential string into segments the same way
 * `redactCredentials` (@app/core/formatters) does, and returns the segment
 * containing "@" (the identity/email part), or the whole trimmed string if
 * no segment contains "@". */
function extractIdentitySegment(plaintext: string): string {
  const parts = plaintext.replace(/\|/g, ":").split(":");
  const withAt = parts.find((p) => p.includes("@"));
  return (withAt ?? plaintext).trim();
}

/** trim().toLowerCase() of the identity/email segment only. */
export function normalizeIdentity(plaintext: string): string {
  return extractIdentitySegment(plaintext).toLowerCase();
}

/** Canonical form of the WHOLE credential string for fingerprinting: split
 * the same way as extractIdentitySegment, trim each segment, collapse
 * internal whitespace in each segment, lowercase ONLY the identity segment
 * (the first one containing "@" — never a password segment), rejoin with ":" so "email|pw" and
 * "email:pw" (same real credential, different admin-typed delimiter)
 * normalize identically. */
export function normalizeCredential(plaintext: string): string {
  const parts = plaintext.replace(/\|/g, ":").split(":");
  // Only the FIRST "@" segment is the identity; a later one is a password containing "@".
  const identityIndex = parts.findIndex((p) => p.includes("@"));
  const normalized = parts.map((raw, i) => {
    const collapsed = raw.trim().replace(/\s+/g, " ");
    return i === identityIndex ? collapsed.toLowerCase() : collapsed;
  });
  return normalized.join(":");
}

/** HMAC-SHA256(indexKey, normalizeIdentity(plaintext)), hex-encoded. */
export function computeIdentityFingerprint(plaintext: string): string {
  return createHmac("sha256", deriveCredentialIndexKey()).update(normalizeIdentity(plaintext)).digest("hex");
}

/** HMAC-SHA256(indexKey, normalizeCredential(plaintext)), hex-encoded. */
export function computeCredentialFingerprint(plaintext: string): string {
  return createHmac("sha256", deriveCredentialIndexKey()).update(normalizeCredential(plaintext)).digest("hex");
}
