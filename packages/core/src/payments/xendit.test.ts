import { describe, it, expect, vi } from "vitest";
import { xenditMode, checkXenditConnection } from "./xendit";

const KEY = "xnd_development_abc123";

function fakeFetch(status: number, body: unknown = {}) {
  return vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body });
}

describe("xenditMode", () => {
  it("detects test keys", () => expect(xenditMode("xnd_development_x")).toBe("test"));
  it("detects live keys", () => expect(xenditMode("xnd_production_x")).toBe("live"));
  it("returns null for anything else", () => expect(xenditMode("sk_live_x")).toBeNull());
});

describe("checkXenditConnection", () => {
  it("parses the balance on 200 and reports the mode", async () => {
    const f = fakeFetch(200, { balance: 125000 });
    const r = await checkXenditConnection(KEY, f as unknown as typeof fetch);
    expect(r).toEqual({ ok: true, mode: "test", balance: 125000 });
  });

  it("sends Basic auth of `key:` to the balance endpoint", async () => {
    const f = fakeFetch(200, { balance: 1 });
    await checkXenditConnection(KEY, f as unknown as typeof fetch);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://api.xendit.co/balance");
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from(`${KEY}:`).toString("base64")}`);
  });

  it("maps 401 to unauthorized", async () => {
    const r = await checkXenditConnection(KEY, fakeFetch(401) as unknown as typeof fetch);
    expect(r).toEqual({ ok: false, reason: "unauthorized", status: 401 });
  });

  it("maps other failures to http_error", async () => {
    const r = await checkXenditConnection(KEY, fakeFetch(500) as unknown as typeof fetch);
    expect(r).toEqual({ ok: false, reason: "http_error", status: 500 });
  });

  it("maps a thrown fetch to network without leaking the key", async () => {
    const f = vi.fn().mockRejectedValue(Object.assign(new Error(`boom ${KEY}`), { cause: { key: KEY } }));
    const r = await checkXenditConnection(KEY, f as unknown as typeof fetch);
    expect(r).toEqual({ ok: false, reason: "network" });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
});
