import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSse } from "./useSse";

class MockEventSource {
  static instances: MockEventSource[] = [];
  onmessage: ((ev: MessageEvent) => void) | null = null;
  closed = false;
  url: string;
  constructor(url: string, _opts?: { withCredentials?: boolean }) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe("useSse", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", MockEventSource);
    MockEventSource.instances = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not construct an EventSource when url is null", () => {
    const queryClient = new QueryClient();
    renderHook(() => useSse(null, ["some-key"]), { wrapper: makeWrapper(queryClient) });
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it("constructs exactly one EventSource against the given URL", () => {
    const queryClient = new QueryClient();
    renderHook(() => useSse("/api/stream", ["some-key"]), { wrapper: makeWrapper(queryClient) });
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]!.url).toBe("/api/stream");
  });

  it("fully replaces the cached value at queryKey when no merge is given", () => {
    const queryClient = new QueryClient();
    renderHook(() => useSse("/api/stream", ["some-key"]), { wrapper: makeWrapper(queryClient) });
    const payload = { status: "success", updated: 5 };
    MockEventSource.instances[0]!.emit(payload);
    expect(queryClient.getQueryData(["some-key"])).toEqual(payload);
  });

  it("calls merge with the previous cache value and the parsed payload, writing its return value", () => {
    interface OrderLike {
      order: { status: string };
    }
    const queryClient = new QueryClient();
    const initial: OrderLike = { order: { status: "PENDING" } };
    queryClient.setQueryData(["order", "1"], initial);
    const merge = vi.fn((prev: OrderLike | undefined, next: unknown): OrderLike => {
      const partial = next as { status: string };
      return { order: { ...prev?.order, status: partial.status } };
    });
    renderHook(() => useSse<OrderLike>("/api/orders/1/stream", ["order", "1"], merge), {
      wrapper: makeWrapper(queryClient),
    });
    const partial = { status: "DELIVERED" };
    MockEventSource.instances[0]!.emit(partial);

    expect(merge).toHaveBeenCalledWith(initial, partial);
    expect(queryClient.getQueryData(["order", "1"])).toEqual({ order: { status: "DELIVERED" } });
  });

  it("ignores a malformed (non-JSON) message without throwing and without touching the cache", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["some-key"], { untouched: true });
    renderHook(() => useSse("/api/stream", ["some-key"]), { wrapper: makeWrapper(queryClient) });

    expect(() => {
      MockEventSource.instances[0]!.onmessage?.({ data: "not json {{{" } as MessageEvent);
    }).not.toThrow();
    expect(queryClient.getQueryData(["some-key"])).toEqual({ untouched: true });
  });

  it("closes the EventSource on unmount", () => {
    const queryClient = new QueryClient();
    const { unmount } = renderHook(() => useSse("/api/stream", ["some-key"]), {
      wrapper: makeWrapper(queryClient),
    });
    const instance = MockEventSource.instances[0]!;
    expect(instance.closed).toBe(false);
    unmount();
    expect(instance.closed).toBe(true);
  });

  it("closes the old EventSource and opens a new one when queryKey content changes", () => {
    const queryClient = new QueryClient();
    const { rerender } = renderHook(({ orderId }: { orderId: string }) => useSse("/api/stream", ["order", orderId]), {
      wrapper: makeWrapper(queryClient),
      initialProps: { orderId: "1" },
    });
    expect(MockEventSource.instances).toHaveLength(1);
    const first = MockEventSource.instances[0]!;
    expect(first.closed).toBe(false);

    rerender({ orderId: "2" });

    expect(first.closed).toBe(true);
    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[1]!.closed).toBe(false);
  });
  it("uses the latest merger without reconnecting an unchanged subscription", () => {
    const queryClient = new QueryClient();
    const firstMerge = vi.fn((_previous: number | undefined, next: unknown) => Number(next) + 1);
    const nextMerge = vi.fn((_previous: number | undefined, next: unknown) => Number(next) + 10);
    const { rerender } = renderHook(({ merge }) => useSse("/api/stream", ["latest"], merge), {
      wrapper: makeWrapper(queryClient), initialProps: { merge: firstMerge },
    });
    const connection = MockEventSource.instances[0]!;
    connection.emit(2);
    rerender({ merge: nextMerge });
    connection.emit(3);
    expect(MockEventSource.instances).toHaveLength(1);
    expect(connection.closed).toBe(false);
    expect(firstMerge).toHaveBeenCalledTimes(1);
    expect(nextMerge).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(["latest"])).toBe(13);
  });


  it("uses the latest committed merge with an equal inline key without reconnecting", () => {
    const queryClient = new QueryClient();
    const merge = vi.fn((_prev: unknown, next: unknown) => next);
    const { rerender, unmount } = renderHook(({ prefix }) => useSse("/api/stream", ["same-key"],
      (_prev, next) => { merge(_prev, next); return { prefix, next }; }), {
      wrapper: makeWrapper(queryClient), initialProps: { prefix: "old" },
    });
    rerender({ prefix: "new" });
    expect(MockEventSource.instances).toHaveLength(1);
    const source = MockEventSource.instances[0]!;
    source.emit({ value: 2 });
    expect(merge).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(["same-key"])).toEqual({ prefix: "new", next: { value: 2 } });
    unmount();
    source.emit({ value: 3 });
    expect(source.closed).toBe(true);
    expect(merge).toHaveBeenCalledTimes(1);
  });

  it("closes on URL/null transitions and never writes a late message to a new key", () => {
    const queryClient = new QueryClient();
    const initialProps: { url: string | null; id: string } = { url: "/one", id: "1" };
    const { rerender, unmount } = renderHook(({ url, id }: { url: string | null; id: string }) =>
      useSse(url, ["order", id]), { wrapper: makeWrapper(queryClient), initialProps });
    const first = MockEventSource.instances[0]!;
    rerender({ url: "/two", id: "2" });
    expect(first.closed).toBe(true);
    expect(MockEventSource.instances).toHaveLength(2);
    first.emit({ old: true });
    expect(queryClient.getQueryData(["order", "1"])).toBeUndefined();
    MockEventSource.instances[1]!.emit({ current: true });
    expect(queryClient.getQueryData(["order", "2"])).toEqual({ current: true });
    rerender({ url: null, id: "2" });
    expect(MockEventSource.instances[1]!.closed).toBe(true);
    expect(MockEventSource.instances).toHaveLength(2);
    unmount();
  });
});
