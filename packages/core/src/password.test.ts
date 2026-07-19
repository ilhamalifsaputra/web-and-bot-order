import { afterEach, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";

/** The work factor bcrypt encoded into a hash string ("$2a$04$..." → 4). */
const costOf = (hash: string): number => Number(hash.split("$")[2]);

describe("password hashing", () => {
  it("verifies a correct password against its hash", () => {
    const h = hashPassword("s3cret-pass");
    expect(h).toMatch(/^\$2[aby]\$/);
    expect(verifyPassword("s3cret-pass", h)).toBe(true);
  });
  it("rejects a wrong password and garbage hashes without throwing", () => {
    const h = hashPassword("s3cret-pass");
    expect(verifyPassword("wrong", h)).toBe(false);
    expect(verifyPassword("anything", "not-a-bcrypt-hash")).toBe(false);
  });
});

// The cost override exists purely so auth tests don't spend seconds inside
// bcryptjs (see vitest.config.ts). These lock in that it works, that it can
// only ever make hashing cheaper INSIDE a test run, and that garbage input
// falls back to the production cost rather than weakening anything.
describe("test-only bcrypt cost override", () => {
  const original = process.env.BCRYPT_COST;
  afterEach(() => {
    if (original === undefined) delete process.env.BCRYPT_COST;
    else process.env.BCRYPT_COST = original;
  });

  it("hashes at the cost the test env asks for, and those hashes still verify", () => {
    process.env.BCRYPT_COST = "4";
    const h = hashPassword("s3cret-pass");
    expect(costOf(h)).toBe(4);
    expect(verifyPassword("s3cret-pass", h)).toBe(true);
    expect(verifyPassword("wrong", h)).toBe(false);
  });

  it("falls back to the production cost for anything malformed or out of range", () => {
    // 0 and 3 are below bcrypt's floor, 99 is absurd, and a non-number, a
    // fraction or an empty value is a plain typo — none of these may produce
    // a weaker hash than production would.
    for (const bad of ["0", "3", "99", "abc", "", "4.5"]) {
      process.env.BCRYPT_COST = bad;
      expect(costOf(hashPassword("s3cret-pass"))).toBe(12);
    }
    delete process.env.BCRYPT_COST;
    expect(costOf(hashPassword("s3cret-pass"))).toBe(12);
  });

  it("keeps verifying credentials hashed at the production cost", () => {
    // A hash written before this change (or by a real deployment) must keep
    // working — verification reads the cost from the hash, not from the env.
    delete process.env.BCRYPT_COST;
    const productionHash = hashPassword("s3cret-pass");
    expect(costOf(productionHash)).toBe(12);

    process.env.BCRYPT_COST = "4";
    expect(verifyPassword("s3cret-pass", productionHash)).toBe(true);
    expect(verifyPassword("wrong", productionHash)).toBe(false);
  });
});
