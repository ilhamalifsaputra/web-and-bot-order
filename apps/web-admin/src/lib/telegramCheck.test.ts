import { describe, it, expect, afterEach, vi } from "vitest";
import {
  normalizeChannelInput,
  checkBotIsAdminOf,
  resolveJoinUrl,
  matchesExpectedType,
  type ChannelCheck,
} from "./telegramCheck";

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

describe("checkBotIsAdminOf", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetchSequence(responses: unknown[]): void {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const body = responses[call];
        call += 1;
        return { json: async () => body } as Response;
      }),
    );
  }

  it("returns isAdmin: true for status administrator", async () => {
    stubFetchSequence([{ ok: true, result: { id: 111 } }, { ok: true, result: { status: "administrator" } }]);
    expect(await checkBotIsAdminOf("token", -100123)).toEqual({ ok: true, isAdmin: true });
  });

  it("returns isAdmin: true for status creator", async () => {
    stubFetchSequence([{ ok: true, result: { id: 111 } }, { ok: true, result: { status: "creator" } }]);
    expect(await checkBotIsAdminOf("token", -100123)).toEqual({ ok: true, isAdmin: true });
  });

  it("returns isAdmin: false for status member", async () => {
    stubFetchSequence([{ ok: true, result: { id: 111 } }, { ok: true, result: { status: "member" } }]);
    expect(await checkBotIsAdminOf("token", -100123)).toEqual({ ok: true, isAdmin: false });
  });

  it("returns isAdmin: false for status left", async () => {
    stubFetchSequence([{ ok: true, result: { id: 111 } }, { ok: true, result: { status: "left" } }]);
    expect(await checkBotIsAdminOf("token", -100123)).toEqual({ ok: true, isAdmin: false });
  });

  it("returns { ok: false, isAdmin: false } when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    expect(await checkBotIsAdminOf("token", -100123)).toEqual({ ok: false, isAdmin: false });
  });
});

describe("resolveJoinUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses https://t.me/<username> when username is present", async () => {
    const check: ChannelCheck = { ok: true, id: -100123, username: "testiilha", inviteLink: "https://t.me/+abc" };
    expect(await resolveJoinUrl("token", check)).toEqual({ ok: true, url: "https://t.me/testiilha" });
  });

  it("falls back to inviteLink when there is no username", async () => {
    const check: ChannelCheck = { ok: true, id: -100123, inviteLink: "https://t.me/+abc" };
    expect(await resolveJoinUrl("token", check)).toEqual({ ok: true, url: "https://t.me/+abc" });
  });

  it("mints a new invite link via exportChatInviteLink when neither is present", async () => {
    const check: ChannelCheck = { ok: true, id: -100123 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ json: async () => ({ ok: true, result: "https://t.me/+minted" }) }) as Response),
    );
    expect(await resolveJoinUrl("token", check)).toEqual({ ok: true, url: "https://t.me/+minted" });
  });

  it("returns { ok: false } when all sources fail", async () => {
    const check: ChannelCheck = { ok: true, id: -100123 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ json: async () => ({ ok: false }) }) as Response),
    );
    expect(await resolveJoinUrl("token", check)).toEqual({ ok: false });
  });

  it("returns { ok: false } when there's no id to mint an invite link for", async () => {
    const check: ChannelCheck = { ok: true };
    expect(await resolveJoinUrl("token", check)).toEqual({ ok: false });
  });
});

describe("matchesExpectedType", () => {
  it("returns true when check.type is in wantTypes", () => {
    expect(matchesExpectedType({ ok: true, type: "channel" }, ["channel", "group"])).toBe(true);
  });

  it("returns false when check.type is not in wantTypes", () => {
    expect(matchesExpectedType({ ok: true, type: "private" }, ["channel", "group"])).toBe(false);
  });

  it("returns false when check.type is undefined", () => {
    expect(matchesExpectedType({ ok: true }, ["channel", "group"])).toBe(false);
  });

  it("matches supergroup against a wantTypes list containing it", () => {
    expect(matchesExpectedType({ ok: true, type: "supergroup" }, ["supergroup"])).toBe(true);
  });
});
