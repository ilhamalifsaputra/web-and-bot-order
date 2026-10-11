import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAction } from "./useAction";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("useAction", () => {
  it("keeps the newest result when requests finish out of order", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const onSuccess = vi.fn();
    const mutationFn = vi.fn((id: number) => id === 1 ? first.promise : second.promise);
    const { result } = renderHook(() => useAction({ mutationFn, onSuccess }));
    act(() => { result.current.mutate(1); result.current.mutate(2); });
    expect(result.current.isPending).toBe(true);
    await act(async () => { second.resolve("newest"); });
    await act(async () => { first.resolve("older"); });
    expect(result.current.data).toBe("newest");
    expect(result.current.isPending).toBe(false);
    expect(onSuccess).toHaveBeenCalledExactlyOnceWith("newest", 2);
  });

  it("invalidates a pending result when reset", async () => {
    const pending = deferred<string>();
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useAction({ mutationFn: () => pending.promise, onSuccess }));
    act(() => { result.current.mutate(undefined); result.current.reset(); });
    await act(async () => { pending.resolve("obsolete"); });
    expect(result.current.data).toBeUndefined();
    expect(result.current.isPending).toBe(false);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("does not notify consumers after unmounting", async () => {
    const pending = deferred<string>();
    const onSuccess = vi.fn();
    const { result, unmount } = renderHook(() => useAction({ mutationFn: () => pending.promise, onSuccess }));
    act(() => { result.current.mutate(undefined); });
    unmount();
    await act(async () => { pending.resolve("obsolete"); });
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("normalizes thrown errors and ends the pending state", async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useAction({ mutationFn: () => { throw "offline"; }, onError }));
    act(() => { result.current.mutate(undefined); });
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.error?.message).toBe("offline");
    expect(onError).toHaveBeenCalledExactlyOnceWith(result.current.error);
  });
});
