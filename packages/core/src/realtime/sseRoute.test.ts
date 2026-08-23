import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { streamSse, type SseReply, type SseRequest } from "./sseRoute";
import { logger } from "../logger";

/** A minimal ServerResponse-like double the tests control directly. */
function makeFakeRaw() {
  const writes: string[] = [];
  const raw = {
    writeHead: vi.fn(),
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
    end: vi.fn(() => {
      raw.writableEnded = true;
    }),
    destroyed: false,
    writableEnded: false,
    writes,
  };
  return raw;
}

function makeFakeReply() {
  const raw = makeFakeRaw();
  return {
    hijack: vi.fn(),
    raw: raw as unknown as SseReply["raw"],
    fakeRaw: raw,
  };
}

function makeFakeRequest() {
  const raw = new EventEmitter();
  return {
    raw: raw as unknown as SseRequest["raw"],
    fakeRaw: raw,
  };
}

/** Extract just the data:-frame payloads (as parsed JSON) from a raw
 * ServerResponse double's captured writes, ignoring keep-alive comments. */
function dataFrames(writes: string[]): unknown[] {
  return writes
    .filter((w) => w.startsWith("data: "))
    .map((w) => JSON.parse(w.slice("data: ".length, w.length - 2)));
}

describe("streamSse", () => {
  let reply: ReturnType<typeof makeFakeReply>;
  let req: ReturnType<typeof makeFakeRequest>;

  beforeEach(() => {
    vi.useFakeTimers();
    reply = makeFakeReply();
    req = makeFakeRequest();
    vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("writes the initial() value as a data: frame immediately, before any poll tick", async () => {
    const initial = vi.fn().mockResolvedValue({ status: "PENDING" });
    const poll = vi.fn().mockResolvedValue({ status: "PENDING" });
    const subscribe = vi.fn().mockReturnValue(() => {});
    const changed = vi.fn().mockReturnValue(true);

    const done = streamSse(reply as unknown as SseReply, req as unknown as SseRequest, {
      initial,
      poll,
      subscribe,
      changed,
    });
    await vi.waitFor(() => expect(initial).toHaveBeenCalled());
    // let the microtask queue drain so the initial() promise resolves and writes
    await Promise.resolve();
    await Promise.resolve();

    expect(reply.hijack).toHaveBeenCalled();
    expect(reply.fakeRaw.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ "content-type": "text/event-stream" })
    );
    expect(dataFrames(reply.fakeRaw.writes)).toEqual([{ status: "PENDING" }]);
    expect(poll).not.toHaveBeenCalled();

    req.fakeRaw.emit("close");
    await done;
  });

  it("re-reads via poll() and pushes a new frame when subscribe's onChange fires", async () => {
    const initial = vi.fn().mockResolvedValue({ status: "PENDING" });
    const poll = vi.fn().mockResolvedValue({ status: "SUKSES" });
    let onChange: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const subscribe = vi.fn((fn: () => void) => {
      onChange = fn;
      return unsubscribe;
    });
    const changed = vi.fn((prev: { status: string } | null, next: { status: string }) => prev?.status !== next.status);

    const done = streamSse(reply as unknown as SseReply, req as unknown as SseRequest, {
      initial,
      poll,
      subscribe,
      changed,
    });
    await vi.waitFor(() => expect(initial).toHaveBeenCalled());
    await Promise.resolve();
    await Promise.resolve();

    expect(onChange).toBeDefined();
    onChange!();
    await vi.waitFor(() => expect(poll).toHaveBeenCalled());
    await Promise.resolve();
    await Promise.resolve();

    expect(dataFrames(reply.fakeRaw.writes)).toEqual([{ status: "PENDING" }, { status: "SUKSES" }]);

    req.fakeRaw.emit("close");
    await done;
  });

  it("does not write a new frame when poll()'s result doesn't satisfy changed (dedup)", async () => {
    const initial = vi.fn().mockResolvedValue({ status: "PENDING" });
    const poll = vi.fn().mockResolvedValue({ status: "PENDING" });
    let onChange: (() => void) | undefined;
    const subscribe = vi.fn((fn: () => void) => {
      onChange = fn;
      return () => {};
    });
    const changed = vi.fn((prev: { status: string } | null, next: { status: string }) => prev?.status !== next.status);

    const done = streamSse(reply as unknown as SseReply, req as unknown as SseRequest, {
      initial,
      poll,
      subscribe,
      changed,
    });
    await vi.waitFor(() => expect(initial).toHaveBeenCalled());
    await Promise.resolve();
    await Promise.resolve();

    onChange!();
    await vi.waitFor(() => expect(poll).toHaveBeenCalled());
    await Promise.resolve();
    await Promise.resolve();

    // Still only the one initial data: frame -- no duplicate pushed.
    expect(dataFrames(reply.fakeRaw.writes)).toEqual([{ status: "PENDING" }]);

    req.fakeRaw.emit("close");
    await done;
  });

  it("fallback poll tick catches a real change independent of subscribe ever firing", async () => {
    const initial = vi.fn().mockResolvedValue({ status: "PENDING" });
    const poll = vi.fn().mockResolvedValue({ status: "SUKSES" });
    const subscribe = vi.fn().mockReturnValue(() => {});
    const changed = vi.fn((prev: { status: string } | null, next: { status: string }) => prev?.status !== next.status);

    const done = streamSse(reply as unknown as SseReply, req as unknown as SseRequest, {
      initial,
      poll,
      subscribe,
      changed,
      pollIntervalMs: 1000,
    });
    await vi.waitFor(() => expect(initial).toHaveBeenCalled());
    await Promise.resolve();
    await Promise.resolve();

    // subscribe's onChange is deliberately never invoked in this test.
    await vi.advanceTimersByTimeAsync(1000);

    expect(poll).toHaveBeenCalled();
    expect(dataFrames(reply.fakeRaw.writes)).toEqual([{ status: "PENDING" }, { status: "SUKSES" }]);

    req.fakeRaw.emit("close");
    await done;
  });

  it("writes a keep-alive comment (not a data: frame) on an unchanged poll tick", async () => {
    const initial = vi.fn().mockResolvedValue({ status: "PENDING" });
    const poll = vi.fn().mockResolvedValue({ status: "PENDING" });
    const subscribe = vi.fn().mockReturnValue(() => {});
    const changed = vi.fn((prev: { status: string } | null, next: { status: string }) => prev?.status !== next.status);

    const done = streamSse(reply as unknown as SseReply, req as unknown as SseRequest, {
      initial,
      poll,
      subscribe,
      changed,
      pollIntervalMs: 1000,
    });
    await vi.waitFor(() => expect(initial).toHaveBeenCalled());
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1000);

    expect(poll).toHaveBeenCalled();
    expect(dataFrames(reply.fakeRaw.writes)).toEqual([{ status: "PENDING" }]);
    expect(reply.fakeRaw.writes.some((w) => w.startsWith(": keep-alive"))).toBe(true);

    req.fakeRaw.emit("close");
    await done;
  });

  it("clears the interval and unsubscribes exactly once on close", async () => {
    const initial = vi.fn().mockResolvedValue({ status: "PENDING" });
    const poll = vi.fn().mockResolvedValue({ status: "SUKSES" });
    const unsubscribe = vi.fn();
    const subscribe = vi.fn().mockReturnValue(unsubscribe);
    const changed = vi.fn().mockReturnValue(true);

    const done = streamSse(reply as unknown as SseReply, req as unknown as SseRequest, {
      initial,
      poll,
      subscribe,
      changed,
      pollIntervalMs: 1000,
    });
    await vi.waitFor(() => expect(initial).toHaveBeenCalled());
    await Promise.resolve();
    await Promise.resolve();

    req.fakeRaw.emit("close");
    await done;

    expect(unsubscribe).toHaveBeenCalledTimes(1);

    const writesBefore = reply.fakeRaw.writes.length;
    poll.mockClear();
    await vi.advanceTimersByTimeAsync(5000);

    expect(poll).not.toHaveBeenCalled();
    expect(reply.fakeRaw.writes.length).toBe(writesBefore);
  });

  it("a poll() rejection on one tick doesn't crash the connection; the next tick still works", async () => {
    const initial = vi.fn().mockResolvedValue({ status: "PENDING" });
    const poll = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient DB error"))
      .mockResolvedValueOnce({ status: "SUKSES" });
    const subscribe = vi.fn().mockReturnValue(() => {});
    const changed = vi.fn((prev: { status: string } | null, next: { status: string }) => prev?.status !== next.status);

    const done = streamSse(reply as unknown as SseReply, req as unknown as SseRequest, {
      initial,
      poll,
      subscribe,
      changed,
      pollIntervalMs: 1000,
    });
    await vi.waitFor(() => expect(initial).toHaveBeenCalled());
    await Promise.resolve();
    await Promise.resolve();

    // First tick: poll() rejects. Must not throw / crash the test process.
    await vi.advanceTimersByTimeAsync(1000);

    // Second tick: poll() resolves normally, connection is still alive.
    await vi.advanceTimersByTimeAsync(1000);

    expect(dataFrames(reply.fakeRaw.writes)).toEqual([{ status: "PENDING" }, { status: "SUKSES" }]);

    req.fakeRaw.emit("close");
    await done;
  });

  it("double-close is safe: unsubscribe is still only called once", async () => {
    const initial = vi.fn().mockResolvedValue({ status: "PENDING" });
    const poll = vi.fn().mockResolvedValue({ status: "PENDING" });
    const unsubscribe = vi.fn();
    const subscribe = vi.fn().mockReturnValue(unsubscribe);
    const changed = vi.fn().mockReturnValue(false);

    const done = streamSse(reply as unknown as SseReply, req as unknown as SseRequest, {
      initial,
      poll,
      subscribe,
      changed,
    });
    await vi.waitFor(() => expect(initial).toHaveBeenCalled());
    await Promise.resolve();
    await Promise.resolve();

    req.fakeRaw.emit("close");
    req.fakeRaw.emit("close");
    await done;

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  // Regression guard (review finding): cleanup() previously never called
  // reply.raw.end(), so a connection that never got past a failing
  // initial() left the client's EventSource dangling on an open,
  // silent "200 text/event-stream" response forever.
  it("actually ends the response when initial() rejects, instead of leaving the connection open", async () => {
    const initial = vi.fn().mockRejectedValue(new Error("DB unavailable"));
    const poll = vi.fn();
    const subscribe = vi.fn().mockReturnValue(() => {});
    const changed = vi.fn();

    const done = streamSse(reply as unknown as SseReply, req as unknown as SseRequest, {
      initial,
      poll,
      subscribe,
      changed,
    });
    await done;

    expect(reply.fakeRaw.end).toHaveBeenCalledTimes(1);
    expect(poll).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  // Regression guard: a caller-supplied changed() that throws must not
  // produce an unhandled rejection from the fire-and-forget poll tick —
  // it should log and skip the tick, same as a poll() rejection.
  it("a changed() that throws on one tick doesn't crash the connection; the next tick still works", async () => {
    const initial = vi.fn().mockResolvedValue({ status: "PENDING" });
    const poll = vi.fn().mockResolvedValue({ status: "SUKSES" });
    const subscribe = vi.fn().mockReturnValue(() => {});
    const changed = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("changed() bug");
      })
      .mockReturnValueOnce(true);

    const done = streamSse(reply as unknown as SseReply, req as unknown as SseRequest, {
      initial,
      poll,
      subscribe,
      changed,
      pollIntervalMs: 1000,
    });
    await vi.waitFor(() => expect(initial).toHaveBeenCalled());
    await Promise.resolve();
    await Promise.resolve();

    // First tick: changed() throws. Must not throw / crash the test process,
    // and must not write anything for this tick.
    await vi.advanceTimersByTimeAsync(1000);
    expect(dataFrames(reply.fakeRaw.writes)).toEqual([{ status: "PENDING" }]);

    // Second tick: changed() resolves normally, connection is still alive.
    await vi.advanceTimersByTimeAsync(1000);
    expect(dataFrames(reply.fakeRaw.writes)).toEqual([{ status: "PENDING" }, { status: "SUKSES" }]);

    req.fakeRaw.emit("close");
    await done;
  });

  // Regression guard: a caller-supplied subscribe() that throws must not
  // produce an unhandled rejection from the top-level connect IIFE — it
  // should log and close the connection cleanly, same as initial() failing.
  it("closes cleanly (and still ends the response) when subscribe() throws", async () => {
    const initial = vi.fn().mockResolvedValue({ status: "PENDING" });
    const poll = vi.fn();
    const subscribe = vi.fn().mockImplementation(() => {
      throw new Error("subscribe() bug");
    });
    const changed = vi.fn();

    const done = streamSse(reply as unknown as SseReply, req as unknown as SseRequest, {
      initial,
      poll,
      subscribe,
      changed,
    });
    await done;

    expect(dataFrames(reply.fakeRaw.writes)).toEqual([{ status: "PENDING" }]);
    expect(reply.fakeRaw.end).toHaveBeenCalledTimes(1);
    expect(poll).not.toHaveBeenCalled();
  });
});
