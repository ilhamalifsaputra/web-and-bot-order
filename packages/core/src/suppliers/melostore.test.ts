import { createHmac } from "node:crypto";
import { describe, it, expect, vi, afterEach } from "vitest";
import { checkGameNickname } from "./melostore";

const CREDS = { apiKey: "ms-api-k3y", secretKey: "ms-s3cr3t-key" };

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

describe("checkGameNickname (MeloStore)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns valid:true with the resolved nickname on a successful lookup", async () => {
    stubFetchJson({ code: 0, message: "Success", data: { nickname: "ProGamer99" } });
    const r = await checkGameNickname(CREDS, { gameCode: "mobile-legends", id: "123456789", server: "1234" });
    expect(r.valid).toBe(true);
    expect(r.nickname).toBe("ProGamer99");
  });

  it("returns valid:false with a null nickname (never throws) for error code 4001 (account not found)", async () => {
    stubFetchJson({ code: 4001, message: "Account not found" });
    const r = await checkGameNickname(CREDS, { gameCode: "mobile-legends", id: "0" });
    expect(r.valid).toBe(false);
    expect(r.nickname).toBeNull();
  });

  it("returns valid:false with a null nickname (never throws) for error code 4006 (invalid target)", async () => {
    stubFetchJson({ code: 4006, message: "Target parameter input is incomplete or invalid" });
    const r = await checkGameNickname(CREDS, { gameCode: "mobile-legends", id: "" });
    expect(r.valid).toBe(false);
    expect(r.nickname).toBeNull();
  });

  it("throws a credential-free error on a genuine non-2xx HTTP failure (not 4001/4006)", async () => {
    stubFetchJson({}, { ok: false, status: 502 });
    let caught: unknown;
    try {
      await checkGameNickname(CREDS, { gameCode: "mobile-legends", id: "1" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/HTTP 502/);
    expect(message).not.toContain(CREDS.apiKey);
    expect(message).not.toContain(CREDS.secretKey);
  });

  it("throws (does not silently return valid:false) when the response body is well-formed JSON but carries an undocumented code", async () => {
    stubFetchJson({ code: 9999, message: "Unknown" });
    await expect(checkGameNickname(CREDS, { gameCode: "mobile-legends", id: "1" })).rejects.toThrow(
      /unexpected response|unrecognized/i,
    );
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
    await expect(checkGameNickname(CREDS, { gameCode: "mobile-legends", id: "1" })).rejects.toThrow(/unparseable/);
  });

  it("throws a credential-free error on timeout", async () => {
    // Simulates what AbortSignal.timeout produces once the deadline elapses
    // (a rejection named "TimeoutError") without actually waiting out the
    // real HTTP_TIMEOUT_MS.gatewayRead deadline in this test.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        const err = new Error("The operation was aborted");
        err.name = "TimeoutError";
        return Promise.reject(err);
      }),
    );
    let caught: unknown;
    try {
      await checkGameNickname(CREDS, { gameCode: "mobile-legends", id: "1" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/timed out/);
    expect(message).not.toContain(CREDS.apiKey);
    expect(message).not.toContain(CREDS.secretKey);
  });

  it("sends X-API-Key, X-Secret-Key, and an X-H2H-Signature computed over the exact sent body string", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, message: "Success", data: { nickname: "X" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await checkGameNickname(CREDS, { gameCode: "mobile-legends", id: "123456789", server: "1234" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toContain("/check-nickname");
    expect(url).not.toContain(CREDS.apiKey);
    expect(url).not.toContain(CREDS.secretKey);

    const headers = init.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe(CREDS.apiKey);
    expect(headers["X-Secret-Key"]).toBe(CREDS.secretKey);
    expect(typeof headers["X-H2H-Signature"]).toBe("string");

    const sentBodyString = init.body as string;
    const expectedSignature = createHmac("sha256", CREDS.secretKey).update(sentBodyString).digest("hex");
    expect(headers["X-H2H-Signature"]).toBe(expectedSignature);

    const sentBody = JSON.parse(sentBodyString);
    expect(sentBody).toEqual({ game_code: "mobile-legends", target: "123456789", target_zone: "1234" });
  });

  it("omits target_zone from the request body when server is not provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, message: "Success", data: { nickname: "X" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await checkGameNickname(CREDS, { gameCode: "free-fire", id: "999" });

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody).toEqual({ game_code: "free-fire", target: "999" });
  });

  it("never leaks apiKey or secretKey in any thrown error's message, across every failure mode", async () => {
    const failureModes: Array<() => void> = [
      () => stubFetchJson({}, { ok: false, status: 500 }),
      () => stubFetchJson({ code: 9999 }),
      () =>
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => {
              throw new Error(`boom with api key ${CREDS.apiKey}`);
            },
          }),
        ),
    ];

    for (const setup of failureModes) {
      setup();
      let caught: unknown;
      try {
        await checkGameNickname(CREDS, { gameCode: "mobile-legends", id: "1" });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message).not.toContain(CREDS.apiKey);
      expect(message).not.toContain(CREDS.secretKey);
      vi.unstubAllGlobals();
    }
  });
});
