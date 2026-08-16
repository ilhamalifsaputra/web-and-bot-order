import { createHash } from "node:crypto";
import { describe, it, expect, vi, afterEach } from "vitest";
import { checkGameRegion } from "./vipreseller";

const CREDS = { apiId: "vr-id-123", apiKey: "vr-s3cr3t-key" };

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

describe("checkGameRegion", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the country code for a Mobile Legends lookup that carries country data", async () => {
    stubFetchJson({ result: true, data: "ProPlayer123", message: "Success.", country: { code: "ID", name: "Indonesia" } });
    const r = await checkGameRegion(CREDS, { gameCode: "mobile-legends", id: "123456789", server: "1234" });
    expect(r.countryCode).toBe("ID");
  });

  it("returns countryCode:null (never throws) for a successful lookup on a game with no country data", async () => {
    stubFetchJson({ result: true, data: "SomeNickname", message: "Success." });
    const r = await checkGameRegion(CREDS, { gameCode: "free-fire", id: "999" });
    expect(r.countryCode).toBeNull();
  });

  it("returns countryCode:null (never throws) for a not-found account", async () => {
    stubFetchJson({ result: false, message: "Account not found" });
    const r = await checkGameRegion(CREDS, { gameCode: "mobile-legends", id: "0" });
    expect(r.countryCode).toBeNull();
  });

  it("sends key/sign/type/code/target in the POST body, and additional_target only when server is provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: true, data: "X", message: "Success." }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await checkGameRegion(CREDS, { gameCode: "mobile-legends", id: "123456789", server: "1234" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toContain("/game-feature");
    expect(url).not.toContain(CREDS.apiKey);
    expect(url).not.toContain(CREDS.apiId);
    const sentBody = JSON.parse(init.body as string);
    const expectedSign = createHash("md5").update(`${CREDS.apiId}${CREDS.apiKey}`).digest("hex");
    expect(sentBody).toEqual({
      key: CREDS.apiKey,
      sign: expectedSign,
      type: "get-nickname",
      code: "mobile-legends",
      target: "123456789",
      additional_target: "1234",
    });
  });

  it("omits additional_target from the request body when server is not provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: true, data: "X", message: "Success." }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await checkGameRegion(CREDS, { gameCode: "free-fire", id: "999" });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody).toEqual({
      key: CREDS.apiKey,
      sign: createHash("md5").update(`${CREDS.apiId}${CREDS.apiKey}`).digest("hex"),
      type: "get-nickname",
      code: "free-fire",
      target: "999",
    });
  });

  it("throws a credential-free error on a genuine network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(
        new Error(`fetch failed: request carrying api_id=${CREDS.apiId} api_key=${CREDS.apiKey} failed`),
      ),
    );
    let caught: unknown;
    try {
      await checkGameRegion(CREDS, { gameCode: "mobile-legends", id: "1" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/network error/);
    expect(message).not.toContain(CREDS.apiKey);
    expect(message).not.toContain(CREDS.apiId);
  });

  it("throws on a genuine non-2xx HTTP failure, without leaking the request body", async () => {
    stubFetchJson({}, { ok: false, status: 502 });
    let caught: unknown;
    try {
      await checkGameRegion(CREDS, { gameCode: "mobile-legends", id: "1" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/HTTP 502/);
    expect(message).not.toContain(CREDS.apiKey);
    expect(message).not.toContain(CREDS.apiId);
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
    await expect(checkGameRegion(CREDS, { gameCode: "mobile-legends", id: "1" })).rejects.toThrow(/unparseable/);
  });
});
