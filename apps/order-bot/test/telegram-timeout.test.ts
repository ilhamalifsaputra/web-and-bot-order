import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTimeout, TELEGRAM_MESSAGE_TIMEOUT_MS, TELEGRAM_DOCUMENT_TIMEOUT_MS } from "../src/payments/telegramTimeout";

describe("withTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the promise's own value when it settles before the deadline", async () => {
    const p = withTimeout(Promise.resolve("done"), 5_000);
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).resolves.toBe("done");
  });

  it("resolves to \"timeout\" once the deadline elapses without the promise settling", async () => {
    const hung = new Promise<string>(() => {}); // never settles
    const p = withTimeout(hung, 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(p).resolves.toBe("timeout");
  });

  it("still rejects with the original error when the wrapped promise rejects before the deadline", async () => {
    const err = new Error("boom");
    // Reject AFTER withTimeout has attached its own .then handler (rather
    // than passing an already-rejected Promise.reject(err) straight in), and
    // attach this test's own `.rejects` handler on `p` BEFORE the rejection
    // ever propagates — otherwise `p` briefly rejects with nothing listening
    // yet and Node reports an unhandled rejection even though this test does
    // eventually await it.
    let rejectRejecting: ((e: unknown) => void) | undefined;
    const rejecting = new Promise<string>((_resolve, reject) => {
      rejectRejecting = reject;
    });
    const p = withTimeout(rejecting, 5_000);
    const assertion = expect(p).rejects.toBe(err);
    rejectRejecting?.(err);
    await vi.advanceTimersByTimeAsync(0);
    await assertion;
  });

  it("a late resolution after the deadline has already fired does not change the already-settled \"timeout\" outcome", async () => {
    let resolveLate: ((v: string) => void) | undefined;
    const late = new Promise<string>((resolve) => {
      resolveLate = resolve;
    });
    const p = withTimeout(late, 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(p).resolves.toBe("timeout");
    // The underlying promise settling afterward must not throw or alter `p` —
    // withTimeout's own doc-comment: the wrapped call isn't cancelled, it may
    // still complete in the background, only the CALLER's wait is bounded.
    expect(() => resolveLate?.("too late")).not.toThrow();
  });
});

describe("Telegram timeout budgets", () => {
  it("the document-upload budget is larger than the plain-message budget, reflecting a real upload's extra cost", () => {
    expect(TELEGRAM_DOCUMENT_TIMEOUT_MS).toBeGreaterThan(TELEGRAM_MESSAGE_TIMEOUT_MS);
  });

  it("both budgets stay well under grammY's 500s per-call default", () => {
    expect(TELEGRAM_MESSAGE_TIMEOUT_MS).toBeLessThan(60_000);
    expect(TELEGRAM_DOCUMENT_TIMEOUT_MS).toBeLessThan(60_000);
  });
});
