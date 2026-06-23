/**
 * Admin-3 fix (security audit, 2026-06-23): checkTokenWithTelegram /
 * checkChannelWithTelegram must abort a hung api.telegram.org call rather
 * than holding this single-process app's request thread open indefinitely.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { checkTokenWithTelegram, checkChannelWithTelegram } from "../src/lib/telegramCheck";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A fetch stub that never resolves on its own — only rejects if aborted. */
function hangingFetch() {
  return vi.fn((_url: string, opts?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }),
  );
}

describe("checkTokenWithTelegram timeout", () => {
  it("aborts and returns ok:false when the call never resolves", async () => {
    vi.useFakeTimers();
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);

    const promise = checkTokenWithTelegram("123:fake-token");
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(result).toEqual({ ok: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, opts] = fetchMock.mock.calls[0]!;
    expect((opts as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
  });

  it("still resolves normally well under the timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: async () => ({ ok: true, result: { username: "test_bot" } }) }),
    );
    const result = await checkTokenWithTelegram("123:fake-token");
    expect(result).toEqual({ ok: true, username: "test_bot" });
  });
});

describe("checkChannelWithTelegram timeout", () => {
  it("aborts and returns ok:false when the call never resolves", async () => {
    vi.useFakeTimers();
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);

    const promise = checkChannelWithTelegram("123:fake-token", "@somechannel");
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(result).toEqual({ ok: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
