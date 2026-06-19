import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";

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
