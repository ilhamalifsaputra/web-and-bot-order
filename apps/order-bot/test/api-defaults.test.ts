/**
 * The shared API transformer: HTML/link-preview defaults, the custom-emoji
 * upgrade on the way out, and the plain-emoji retry when Telegram refuses the
 * entity (channel posts / stale ids). No network — `prev` is a spy.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrammyError } from "grammy";
import { resetCustomEmojiMap, setCustomEmojiMap } from "@app/core/customEmoji";
import { htmlDefaultsTransformer } from "../src/util/apiDefaults";

const MAP = JSON.stringify({ "✅": "5368324170671202286" });

/** A rejection of the shape Telegram sends when custom emoji aren't allowed. */
function customEmojiError(description: string): GrammyError {
  return new GrammyError(
    "Call to 'sendMessage' failed!",
    { ok: false, error_code: 400, description },
    "sendMessage",
    {},
  );
}

const ok = () => vi.fn().mockResolvedValue({ ok: true, result: {} });

afterEach(() => resetCustomEmojiMap());

describe("send defaults", () => {
  it("adds HTML and disables link previews when the caller set neither", async () => {
    const prev = ok();
    await htmlDefaultsTransformer()(prev, "sendMessage", { chat_id: 1, text: "hi" }, undefined);
    expect(prev.mock.calls[0]![1]).toMatchObject({
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });

  it("leaves a caller-supplied parse mode and pre-built entities alone", async () => {
    setCustomEmojiMap(MAP);
    const prev = ok();
    const payload = { chat_id: 1, text: "✅ raw", entities: [] };
    await htmlDefaultsTransformer()(prev, "sendMessage", payload, undefined);
    expect(prev.mock.calls[0]![1]).toMatchObject({ text: "✅ raw" });
    expect(prev.mock.calls[0]![1]).not.toHaveProperty("parse_mode");
  });
});

describe("custom emoji", () => {
  it("passes the text through untouched when no map is configured", async () => {
    const prev = ok();
    await htmlDefaultsTransformer()(prev, "sendMessage", { chat_id: 1, text: "✅ done" }, undefined);
    expect((prev.mock.calls[0]![1] as { text: string }).text).toBe("✅ done");
  });

  it("wraps mapped emoji in message text and photo captions", async () => {
    setCustomEmojiMap(MAP);
    const t = htmlDefaultsTransformer();
    const prev = ok();
    await t(prev, "sendMessage", { chat_id: 1, text: "✅ done" }, undefined);
    await t(prev, "sendPhoto", { chat_id: 1, photo: "f", caption: "✅ shot" }, undefined);

    expect((prev.mock.calls[0]![1] as { text: string }).text).toBe(
      '<tg-emoji emoji-id="5368324170671202286">✅</tg-emoji> done',
    );
    expect((prev.mock.calls[1]![1] as { caption: string }).caption).toBe(
      '<tg-emoji emoji-id="5368324170671202286">✅</tg-emoji> shot',
    );
  });

  it("resends with plain emoji when Telegram rejects the entity", async () => {
    setCustomEmojiMap(MAP);
    const prev = vi
      .fn()
      .mockRejectedValueOnce(customEmojiError("Bad Request: CUSTOM_EMOJI_INVALID"))
      .mockResolvedValueOnce({ ok: true, result: {} });

    const res = await htmlDefaultsTransformer()(prev, "sendMessage", { chat_id: 1, text: "✅ done" }, undefined);

    expect(prev).toHaveBeenCalledTimes(2);
    expect((prev.mock.calls[1]![1] as { text: string }).text).toBe("✅ done");
    expect(res).toMatchObject({ ok: true });
  });

  it("rethrows unrelated failures instead of retrying", async () => {
    setCustomEmojiMap(MAP);
    const prev = vi.fn().mockRejectedValue(customEmojiError("Bad Request: chat not found"));

    await expect(
      htmlDefaultsTransformer()(prev, "sendMessage", { chat_id: 1, text: "✅ done" }, undefined),
    ).rejects.toThrow(/chat not found/);
    expect(prev).toHaveBeenCalledTimes(1);
  });
});
