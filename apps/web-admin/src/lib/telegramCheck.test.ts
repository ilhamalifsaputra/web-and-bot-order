import { describe, it, expect } from "vitest";
import { normalizeChannelInput } from "./telegramCheck";

describe("normalizeChannelInput", () => {
  it("strips a full https link to @username", () => {
    expect(normalizeChannelInput("https://t.me/testiilha")).toBe("@testiilha");
  });
  it("strips a bare t.me link to @username", () => {
    expect(normalizeChannelInput("t.me/testiilha")).toBe("@testiilha");
  });
  it("keeps an @username as-is", () => {
    expect(normalizeChannelInput("@testiilha")).toBe("@testiilha");
  });
  it("adds @ to a bare username", () => {
    expect(normalizeChannelInput("testiilha")).toBe("@testiilha");
  });
  it("passes a numeric -100 id through untouched", () => {
    expect(normalizeChannelInput("-1003960444894")).toBe("-1003960444894");
  });
  it("trims surrounding whitespace", () => {
    expect(normalizeChannelInput("  @testiilha  ")).toBe("@testiilha");
  });
});
