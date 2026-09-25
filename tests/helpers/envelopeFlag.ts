/**
 * Fase 6d: run the enclosing describe block with CREDENTIAL_ENVELOPE_WRITE_V2
 * on or off, restoring the previous value afterwards. Callers pair it with
 * `describe.each([false, true])` so every credential caller is proven under
 * both rollout stages.
 *
 * Test debt: older tests call decryptCredentials(x) without a context, which
 * only works on v1, so they fail when the whole suite runs with the flag on.
 * A future CI job should run packages/db and scripts with
 * CREDENTIAL_ENVELOPE_WRITE_V2=true once those calls pass their context.
 */
import { afterEach, beforeEach } from "vitest";
import { encryptCredentials } from "@app/core/credentialCrypto";

export function useEnvelopeWriteV2(on: boolean): void {
  const original = process.env.CREDENTIAL_ENVELOPE_WRITE_V2;
  beforeEach(() => {
    if (on) process.env.CREDENTIAL_ENVELOPE_WRITE_V2 = "true";
    else delete process.env.CREDENTIAL_ENVELOPE_WRITE_V2;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CREDENTIAL_ENVELOPE_WRITE_V2;
    else process.env.CREDENTIAL_ENVELOPE_WRITE_V2 = original;
  });
}

/** A pre-6d (v1, no AAD) envelope whatever the flag says: for fixtures that
 * stand in for rows written before 6d, or that are inserted before their id
 * exists. v1 ignores the context, so the placeholder below is never bound. */
export function encryptLegacyV1(plaintext: string): string {
  const saved = process.env.CREDENTIAL_ENVELOPE_WRITE_V2;
  delete process.env.CREDENTIAL_ENVELOPE_WRITE_V2;
  try {
    return encryptCredentials(plaintext, "test.legacy-v1-fixture");
  } finally {
    if (saved !== undefined) process.env.CREDENTIAL_ENVELOPE_WRITE_V2 = saved;
  }
}
