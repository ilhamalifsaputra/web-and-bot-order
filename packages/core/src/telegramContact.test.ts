import { describe, expect, it } from "vitest";
import { telegramContactUrl } from "./telegramContact";

describe("telegramContactUrl", () => {
  it.each([
    ["@shopsupport", "https://t.me/shopsupport"],
    ["shopsupport", "https://t.me/shopsupport"],
    ["  @Shop_Support1  ", "https://t.me/Shop_Support1"],
    ["t.me/shopsupport", "https://t.me/shopsupport"],
    ["telegram.me/shopsupport", "https://t.me/shopsupport"],
    ["https://t.me/shopsupport", "https://t.me/shopsupport"],
    ["http://t.me/shopsupport/", "https://t.me/shopsupport"],
    ["https://www.t.me/shopsupport", "https://t.me/shopsupport"],
    ["https://telegram.me/shopsupport?start=x", "https://t.me/shopsupport"],
    ["t.me/+AbCdEf12345", "https://t.me/+AbCdEf12345"],
    ["https://t.me/joinchat/AbCdEf12345", "https://t.me/joinchat/AbCdEf12345"],
  ])("accepts %s", (raw, url) => {
    expect(telegramContactUrl(raw)).toBe(url);
  });

  it.each([
    null,
    undefined,
    "",
    "   ",
    "@",
    "abcd", // 4 chars: below the 5-char minimum
    "a".repeat(33), // above the 32-char maximum
    "1shopsupport", // starts with a digit
    "_shopsupport", // starts with an underscore
    "shopsupport_", // ends with an underscore
    "shop support",
    "shop-support",
    "@shop@support",
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)//t.me/shopsupport",
    "https://evil.example/shopsupport",
    "https://t.me.evil.example/shopsupport",
    "https://evil.example/t.me/shopsupport",
    "ftp://t.me/shopsupport",
    "//t.me/shopsupport",
    "https://user@t.me/shopsupport",
    "https://t.me:8080/shopsupport",
    "https://t.me/",
    "https://t.me/shop/support",
    "t.me/+short",
    "t.me/joinchat/",
    "<script>alert(1)</script>",
    "shopsupport\nhttps://evil.example",
    'https://t.me/shopsupport"onclick="x',
  ])("rejects %j", (raw) => {
    expect(telegramContactUrl(raw as string | null | undefined)).toBeNull();
  });
});
