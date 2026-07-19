import bcrypt from "bcryptjs";

/**
 * bcrypt work factor for every password this app hashes. Deliberately a
 * constant and NOT a config knob: there is no env var, setting, or code path
 * that can lower it in a running shop, so a stray `BCRYPT_COST=4` in a
 * production `.env` cannot quietly weaken stored credentials.
 */
const PRODUCTION_COST = 12;

// bcryptjs is pure JS, so cost 12 costs ~450ms per hash AND ~500ms per compare
// on a normal machine. A single integration test that drives five failed
// logins against a real account therefore spends ~3s inside bcrypt alone,
// which under a loaded parallel test run pushed it past Vitest's 5s default
// timeout and made it flaky. Tests may dial the cost down; nothing else can.
const IS_TEST = process.env.VITEST === "true" || process.env.NODE_ENV === "test";

function saltRounds(): number {
  if (!IS_TEST) return PRODUCTION_COST;
  const requested = Number(process.env.BCRYPT_COST);
  // Anything malformed or out of range falls back to the production cost —
  // a typo in the test env weakens nothing, it just runs slower.
  return Number.isInteger(requested) && requested >= 4 && requested <= PRODUCTION_COST
    ? requested
    : PRODUCTION_COST;
}

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, bcrypt.genSaltSync(saltRounds()));
}

/**
 * Verification reads the work factor out of the stored hash, so it needs no
 * cost of its own — hashes written at cost 12 keep verifying at cost 12 even
 * if this process is hashing new passwords at a different one.
 */
export function verifyPassword(plain: string, hashed: string): boolean {
  try {
    return bcrypt.compareSync(plain, hashed);
  } catch {
    return false;
  }
}
