import { afterEach, describe, expect, it } from "vitest";
import {
  applyCustomEmoji,
  hasCustomEmoji,
  resetCustomEmojiMap,
  setCustomEmojiMap,
  stripCustomEmoji,
} from "./customEmoji";

const MAP = JSON.stringify({ "✅": "5368324170671202286", "🛍️": "5368324170671202287" });

afterEach(() => resetCustomEmojiMap());

describe("setCustomEmojiMap", () => {
  it("is a no-op map when unset, blank, malformed or not an object", () => {
    for (const value of [null, undefined, "   ", "{oops", '["✅","1"]', '"x"']) {
      setCustomEmojiMap(value);
      expect(hasCustomEmoji()).toBe(false);
      expect(applyCustomEmoji("✅ done")).toBe("✅ done");
    }
  });

  it("drops entries whose id is not numeric but keeps the rest", () => {
    setCustomEmojiMap(JSON.stringify({ "✅": "123", "❌": "not-an-id", "⚠️": 7 }));
    expect(hasCustomEmoji()).toBe(true);
    expect(applyCustomEmoji("✅ ❌ ⚠️")).toBe(
      '<tg-emoji emoji-id="123">✅</tg-emoji> ❌ ⚠️',
    );
  });
});

describe("applyCustomEmoji", () => {
  it("wraps every occurrence of a mapped emoji", () => {
    setCustomEmojiMap(MAP);
    expect(applyCustomEmoji("✅ paid ✅")).toBe(
      '<tg-emoji emoji-id="5368324170671202286">✅</tg-emoji> paid <tg-emoji emoji-id="5368324170671202286">✅</tg-emoji>',
    );
  });

  it("leaves markup and tag internals alone", () => {
    setCustomEmojiMap(MAP);
    const html = '<b>✅ ok</b> <a href="https://x.test/✅">link</a> <code>ORD-1</code>';
    expect(applyCustomEmoji(html)).toBe(
      '<b><tg-emoji emoji-id="5368324170671202286">✅</tg-emoji> ok</b> <a href="https://x.test/✅">link</a> <code>ORD-1</code>',
    );
  });

  it("leaves emoji inside code blocks verbatim (copyable text, no nested entity)", () => {
    setCustomEmojiMap(MAP);
    expect(applyCustomEmoji('<pre>{"✅": "123"}</pre> ✅')).toBe(
      '<pre>{"✅": "123"}</pre> <tg-emoji emoji-id="5368324170671202286">✅</tg-emoji>',
    );
    expect(applyCustomEmoji("<code>✅ ORD-1</code>")).toBe("<code>✅ ORD-1</code>");
  });

  it("handles multi-codepoint emoji (variation selector) as one unit", () => {
    setCustomEmojiMap(MAP);
    expect(applyCustomEmoji("🛍️ cart")).toBe(
      '<tg-emoji emoji-id="5368324170671202287">🛍️</tg-emoji> cart',
    );
  });

  it("is idempotent — already-tagged text passes through", () => {
    setCustomEmojiMap(MAP);
    const once = applyCustomEmoji("✅ paid");
    expect(applyCustomEmoji(once)).toBe(once);
  });

  it("returns the input unchanged when nothing is mapped", () => {
    setCustomEmojiMap(MAP);
    expect(applyCustomEmoji("<b>no emoji here</b>")).toBe("<b>no emoji here</b>");
  });
});

describe("stripCustomEmoji", () => {
  it("round-trips back to the original text", () => {
    setCustomEmojiMap(MAP);
    const original = "<b>✅ Order</b> 🛍️ <code>ORD-1</code>";
    expect(stripCustomEmoji(applyCustomEmoji(original))).toBe(original);
  });

  it("leaves untagged text untouched", () => {
    expect(stripCustomEmoji("<b>✅ Order</b>")).toBe("<b>✅ Order</b>");
  });
});
