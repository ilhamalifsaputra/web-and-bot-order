/**
 * Unit tests for the shared requireAdminId helper — consolidates the 4
 * separate `admin ? admin.id : 0` fallbacks that used to live in
 * handlers/admin.ts, conversations/admin.ts, conversations/reject.ts, and
 * handlers/verification.ts (Log-5-6, backend audit).
 */
import { describe, expect, it } from "vitest";
import { requireAdminId } from "../src/util/adminAudit";

describe("requireAdminId", () => {
  it("throws when the acting admin's User row was not found", () => {
    expect(() => requireAdminId(null)).toThrow();
  });

  it("returns the id of a real admin User row", () => {
    expect(requireAdminId({ id: 7 })).toBe(7);
  });
});
