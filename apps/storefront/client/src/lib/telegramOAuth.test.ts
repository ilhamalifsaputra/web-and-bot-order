import { describe, it, expect } from "vitest";
import { buildTelegramOAuthUrl } from "./telegramOAuth";

describe("buildTelegramOAuthUrl", () => {
  it("builds a valid oauth.telegram.org URL with required parameters", () => {
    const url = buildTelegramOAuthUrl("123456789", "/auth/telegram", "https://example.com");

    expect(url).toContain("https://oauth.telegram.org/auth?");
    expect(url).toContain("bot_id=123456789");
    expect(url).toContain("origin=https%3A%2F%2Fexample.com");
    expect(url).toContain("return_to=https%3A%2F%2Fexample.com%2Fauth%2Ftelegram");
    expect(url).toContain("request_access=write");
    expect(url).toContain("embed=0");
  });

  it("constructs the return_to URL correctly by combining origin and authUrl", () => {
    const url = buildTelegramOAuthUrl("999", "/account/settings/link-telegram", "https://shop.local");

    expect(url).toContain("return_to=https%3A%2F%2Fshop.local%2Faccount%2Fsettings%2Flink-telegram");
  });

  it("handles trailing slashes in the origin", () => {
    const url = buildTelegramOAuthUrl("123", "/auth", "https://example.com/");

    // The URL should still be correctly formed
    expect(url).toContain("oauth.telegram.org/auth?");
    expect(url).toContain("bot_id=123");
  });

  it("uses the exact bot_id provided", () => {
    const url1 = buildTelegramOAuthUrl("111111111", "/auth/telegram", "https://test.com");
    const url2 = buildTelegramOAuthUrl("222222222", "/auth/telegram", "https://test.com");

    expect(url1).toContain("bot_id=111111111");
    expect(url2).toContain("bot_id=222222222");
  });
});
