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
import { logger } from "./logger";

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

/** Raised by `decryptCredentials` for a legacy plaintext (non-envelope) value
 * when ALLOW_LEGACY_PLAINTEXT is off. Never carries the stored value. */
export class LegacyPlaintextCredentialError extends Error {
  constructor() {
    super(
      "A stored credential is legacy plaintext rather than an encrypted envelope, and ALLOW_LEGACY_PLAINTEXT is off. Run the credential encryption backfill scripts, or turn the flag back on.",
    );
    this.name = "LegacyPlaintextCredentialError";
  }
}

/** Read lazily (like the key) so tests can flip it. Permissive unless explicitly
 * set to a false value, until the backfills have been measured on production. */
function legacyPlaintextAllowed(): boolean {
  const raw = process.env.ALLOW_LEGACY_PLAINTEXT;
  if (raw === undefined) return true;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

let legacyPassthroughs = 0;

/** How many legacy plaintext values this process has passed through unchanged. */
export function legacyPlaintextPassthroughCount(): number {
  return legacyPassthroughs;
}

function legacyPlaintext(stored: string): string {
  // An empty value carries no secret; refusing it would only break blank settings.
  if (stored === "") return stored;
  if (!legacyPlaintextAllowed()) throw new LegacyPlaintextCredentialError();
  legacyPassthroughs++;
  if (legacyPassthroughs === 1) {
    logger.warn(
      "A stored credential was read as legacy plaintext (not encrypted). Run the credential encryption backfill scripts; further occurrences in this process are only counted, not logged.",
    );
  }
  return stored;
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
 * Setting ALLOW_LEGACY_PLAINTEXT=false turns that fallback into a
 * LegacyPlaintextCredentialError once the backfills are done.
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
    return legacyPlaintext(stored);
  }
  if (!isEnvelopeShape(parsed)) return legacyPlaintext(stored);

  const key = keyForVersion(parsed.keyVersion);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(parsed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(parsed.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(parsed.ciphertext, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

/**
 * Boot-time check, called from each process's `start()` only (never from
 * buildServer/buildApp, so tests that build an app without a key still run):
 * fails fast with CredentialKeyConfigError when the key is missing or
 * malformed, instead of the first stock upload or delivery discovering it.
 * The round-trip canary proves the key actually works for AES-256-GCM.
 */
export function assertCredentialKeyConfigured(): void {
  keyForVersion(CURRENT_KEY_VERSION);
  const canary = "credential-key-canary";
  if (decryptCredentials(encryptCredentials(canary)) !== canary) {
    throw new CredentialKeyConfigError("CREDENTIAL_ENCRYPTION_KEY failed its encrypt/decrypt round-trip check.");
  }
}

/**
 * Guarded decrypt for DISPLAY and SEARCH paths only (admin lists, exports,
 * previews): an unreadable row becomes null plus a warning naming the row,
 * so one corrupt row cannot break the whole screen. Delivery paths must keep
 * calling `decryptCredentials` so a failure throws and the delivery retries
 * rather than handing a buyer nothing. A misconfigured key is not a per-row
 * problem, so CredentialKeyConfigError is rethrown.
 */
export function tryDecryptCredentials(
  stored: string,
  ctx: { stockItemId: number | null; purpose: string },
): string | null {
  try {
    return decryptCredentials(stored);
  } catch (err) {
    if (err instanceof CredentialKeyConfigError) throw err;
    // Only the error's name: a message could echo part of the stored value.
    logger.warn(
      { stockItemId: ctx.stockItemId, errorName: err instanceof Error ? err.name : typeof err },
      `Could not decrypt the credentials of stock item ${ctx.stockItemId ?? "(unknown)"} for ${ctx.purpose}; the row is skipped there. It is corrupted, tampered with, or was encrypted under a different key.`,
    );
    return null;
  }
}

// ── Order.deliveredContent (Fase 6c) ───────────────────────────────────────
// The admin-typed manual account or the supplier's serial number delivered to
// a buyer. Same envelope, key and legacy-plaintext rules as
// StockItem.credentials; a row written before 6c stays plaintext until
// scripts/backfill-encrypt-delivered-content.ts rewrites it.

/** Every writer of Order.deliveredContent must store this, never the plaintext. */
export function encryptDeliveredContent(plaintext: string): string {
  return encryptCredentials(plaintext);
}

/** Delivery-path read: throws on an unreadable value so the send retries
 * instead of handing the buyer nothing. Null means nothing was delivered. */
export function decryptDeliveredContent(stored: string | null): string | null {
  return stored === null ? null : decryptCredentials(stored);
}

/** DISPLAY-ONLY twin of decryptDeliveredContent (see tryDecryptCredentials):
 * an unreadable value becomes null plus a warning naming the order. */
export function tryDecryptDeliveredContent(
  stored: string | null,
  ctx: { orderId: number; purpose: string },
): string | null {
  if (stored === null) return null;
  try {
    return decryptCredentials(stored);
  } catch (err) {
    if (err instanceof CredentialKeyConfigError) throw err;
    // Only the error's name: a message could echo part of the stored value.
    logger.warn(
      { orderId: ctx.orderId, errorName: err instanceof Error ? err.name : typeof err },
      `Could not decrypt the delivered content of order ${ctx.orderId} for ${ctx.purpose}; it is shown as empty there. It is corrupted, tampered with, or was encrypted under a different key.`,
    );
    return null;
  }
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

interface IdentitySplit {
  /** Raw text before the identity segment's leading delimiter, or null if the identity is first. */
  before: string | null;
  identity: string;
  /** Raw text after the identity segment's trailing delimiter, or null if the identity is last. */
  after: string | null;
}

/** Splits on ":"/"|" the same way `redactCredentials` (@app/core/formatters)
 * does. The identity is the first segment containing "@"; with no "@" it is
 * the first segment (the whole string for a single-segment credential). Text
 * around it is returned raw so password delimiters/whitespace survive. */
function splitIdentity(plaintext: string): IdentitySplit {
  const tokens = plaintext.split(/([:|])/); // segments at even indexes, delimiters at odd ones
  const segmentCount = (tokens.length + 1) / 2;
  let index = 0;
  for (let i = 0; i < segmentCount; i++) {
    if (tokens[i * 2]!.includes("@")) {
      index = i;
      break;
    }
  }
  return {
    before: index > 0 ? tokens.slice(0, index * 2 - 1).join("") : null,
    identity: tokens[index * 2]!,
    after: index < segmentCount - 1 ? tokens.slice(index * 2 + 2).join("") : null,
  };
}

/** An e-mail identity is case-insensitive (trimmed, whitespace-collapsed, lowercased); any other
 * identity — a username or a voucher/game code — is case-sensitive and only trimmed. */
function canonicalIdentity(raw: string): string {
  if (!raw.includes("@")) return raw.trim();
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

/** The identity segment, canonicalized as in canonicalIdentity. */
export function normalizeIdentity(plaintext: string): string {
  return canonicalIdentity(splitIdentity(plaintext).identity);
}

/** Canonical form of the WHOLE credential for fingerprinting: the identity
 * segment is normalized as in normalizeIdentity (case-folded only for an e-mail), the delimiters on either
 * side of it become ":" (so "email|pw" and "email:pw" match) with the
 * whitespace hugging them trimmed, and every other character — password
 * case, inner whitespace, inner ":"/"|" — is kept exactly. */
export function normalizeCredential(plaintext: string): string {
  const { before, identity, after } = splitIdentity(plaintext);
  const parts: string[] = [];
  if (before !== null) parts.push(before.trim());
  parts.push(canonicalIdentity(identity));
  if (after !== null) parts.push(after.trim());
  return parts.join(":");
}

/** HMAC-SHA256(indexKey, normalizeIdentity(plaintext)), hex-encoded. */
export function computeIdentityFingerprint(plaintext: string): string {
  return createHmac("sha256", deriveCredentialIndexKey()).update(normalizeIdentity(plaintext)).digest("hex");
}

/** HMAC-SHA256(indexKey, normalizeCredential(plaintext)), hex-encoded. */
export function computeCredentialFingerprint(plaintext: string): string {
  return createHmac("sha256", deriveCredentialIndexKey()).update(normalizeCredential(plaintext)).digest("hex");
}

/** Keyed HMAC of one stock-import upload's raw lines, in order (StockImportBatch.sourceHash):
 * lets two batches be recognised as the same upload without the hash confirming guessed content. */
export function computeImportSourceHash(lines: string[]): string {
  const mac = createHmac("sha256", deriveCredentialIndexKey()).update("stock-import-source/v1");
  for (const line of lines) mac.update("\n").update(line);
  return mac.digest("hex");
}
