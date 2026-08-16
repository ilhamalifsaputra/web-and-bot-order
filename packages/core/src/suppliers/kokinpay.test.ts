import { describe, it, expect, vi, afterEach } from "vitest";
import { checkGameNickname } from "./kokinpay";

const CREDS = { apiKey: "kp-s3cr3t-key" };

function stubFetchJson(payload: unknown, opts: { ok?: boolean; status?: number } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => payload,
    }),
  );
}

describe("checkGameNickname", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns valid:true with the resolved nickname on a successful lookup", async () => {
    stubFetchJson({ status: true, data: { nickname: "ProPlayer123" } });
    const r = await checkGameNickname(CREDS, { gameCode: "mobile-legends", id: "123456789", server: "1234" });
    expect(r.valid).toBe(true);
    expect(r.nickname).toBe("ProPlayer123");
  });

  it("returns valid:false with a null nickname (never throws) for a not-found account", async () => {
    stubFetchJson({ status: false, message: "Account not found" }, { ok: false, status: 404 });
    const r = await checkGameNickname(CREDS, { gameCode: "mobile-legends", id: "0" });
    expect(r.valid).toBe(false);
    expect(r.nickname).toBeNull();
  });

  it("returns valid:false (never throws) for an invalid game_code", async () => {
    stubFetchJson({ status: false, message: "Invalid game_code" }, { ok: false, status: 400 });
    const r = await checkGameNickname(CREDS, { gameCode: "not-a-real-game", id: "123" });
    expect(r.valid).toBe(false);
    expect(r.nickname).toBeNull();
  });

  it("sends api_key/id/game_code in the POST body, and server only when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: true, data: { nickname: "X" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await checkGameNickname(CREDS, { gameCode: "mobile-legends", id: "123456789", server: "1234" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toContain("/check-nickname");
    expect(url).not.toContain(CREDS.apiKey);
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody).toEqual({ api_key: CREDS.apiKey, id: "123456789", game_code: "mobile-legends", server: "1234" });
  });

  it("omits server from the request body when not provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: true, data: { nickname: "X" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await checkGameNickname(CREDS, { gameCode: "free-fire", id: "999" });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody).toEqual({ api_key: CREDS.apiKey, id: "999", game_code: "free-fire" });
  });

  it("throws a credential-free error on a genuine network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error(`fetch failed: request carrying api_key=${CREDS.apiKey} failed`)),
    );
    let caught: unknown;
    try {
      await checkGameNickname(CREDS, { gameCode: "mobile-legends", id: "1" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/network error/);
    expect(message).not.toContain(CREDS.apiKey);
  });

  it("throws on a genuine non-2xx HTTP failure other than 400/404, without leaking the request body", async () => {
    stubFetchJson({}, { ok: false, status: 502 });
    await expect(checkGameNickname(CREDS, { gameCode: "mobile-legends", id: "1" })).rejects.toThrow(/HTTP 502/);
  });

  it("throws when the response body is unparseable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("boom");
        },
      }),
    );
    await expect(checkGameNickname(CREDS, { gameCode: "mobile-legends", id: "1" })).rejects.toThrow(
      /unparseable/,
    );
  });
});
