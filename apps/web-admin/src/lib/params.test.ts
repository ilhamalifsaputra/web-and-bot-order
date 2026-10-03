import { describe, expect, it } from "vitest";
import { parsePositiveId, MAX_DB_ID } from "./params";

describe("parsePositiveId", () => {
  it("accepts plain positive integers", () => {
    expect(parsePositiveId("1")).toBe(1);
    expect(parsePositiveId("42")).toBe(42);
    expect(parsePositiveId(String(MAX_DB_ID))).toBe(MAX_DB_ID);
  });

  it.each(["abc", "1.5", "-1", "0", "", " 1", "1e3", "0x10", "01", "+1", "Infinity", String(MAX_DB_ID + 1)])(
    "rejects %j",
    (raw) => {
      expect(parsePositiveId(raw)).toBeNull();
    },
  );

  it("rejects non-strings", () => {
    expect(parsePositiveId(undefined)).toBeNull();
    expect(parsePositiveId(5 as unknown)).toBeNull();
  });

  it("allows a larger ceiling for Telegram ids", () => {
    expect(parsePositiveId("7123456789", { max: Number.MAX_SAFE_INTEGER })).toBe(7123456789);
    expect(parsePositiveId("7123456789")).toBeNull();
  });
});
