import { describe, it, expect } from "vitest";
import { setWebSecret } from "./runtime";
import { mintGuestOrderAccess, verifyGuestOrderAccess, GUEST_ORDER_ACCESS_TTL_SECONDS } from "./guestOrderAccess";

describe("token akses guest", () => {
  it("acak, terikat order, kedaluwarsa dan menolak manipulasi", () => {
    setWebSecret("fixture-security-secret-at-least-32-characters");
    const now = 1_800_000_000_000;
    const token = mintGuestOrderAccess("ORD-A", now);
    expect(token).not.toBe(mintGuestOrderAccess("ORD-A", now));
    expect(verifyGuestOrderAccess(token, "ORD-A", now)).toBe(true);
    expect(verifyGuestOrderAccess(token, "ORD-B", now)).toBe(false);
    expect(verifyGuestOrderAccess(token + "x", "ORD-A", now)).toBe(false);
    expect(verifyGuestOrderAccess(token, "ORD-A", now - 1000)).toBe(false);
    expect(verifyGuestOrderAccess(token, "ORD-A", now + GUEST_ORDER_ACCESS_TTL_SECONDS * 1000)).toBe(false);
    expect(verifyGuestOrderAccess(null, "ORD-A", now)).toBe(false);
    setWebSecret("different-security-secret-at-least-32-characters");
    expect(verifyGuestOrderAccess(token, "ORD-A", now)).toBe(false);
  });
});
