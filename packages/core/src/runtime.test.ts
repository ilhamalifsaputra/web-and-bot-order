import { describe, it, expect, beforeEach } from "vitest";
import {
  adminIds, isAdmin, setAdminIds, addAdminId, resetBotIdentity,
  webCookieSecret, setWebSecret, setBotIdentity, publicChannelId,
} from "./runtime";

beforeEach(() => resetBotIdentity());

describe("runtime admin ids", () => {
  it("isAdmin reads the stamped set", () => {
    setAdminIds([111, 222]);
    expect(isAdmin(111)).toBe(true);
    expect(isAdmin(999)).toBe(false);
  });
  it("addAdminId extends the live set without duplicates", () => {
    setAdminIds([111]);
    addAdminId(222);
    addAdminId(222);
    expect(adminIds().sort()).toEqual([111, 222]);
    expect(isAdmin(222)).toBe(true);
  });
});
describe("runtime web cookie secret", () => {
  it("returns the stamped secret", () => {
    setWebSecret("a".repeat(40));
    expect(webCookieSecret()).toBe("a".repeat(40));
  });
});
describe("runtime public channel id", () => {
  it("returns the stamped channel id", () => {
    setBotIdentity({ publicChannelId: -1003960444894 });
    expect(publicChannelId()).toBe(-1003960444894);
  });
  it("is undefined when nothing is stamped and env is unset", () => {
    expect(publicChannelId()).toBeUndefined();
  });
});
