import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useOrderStatusStream } from "./useOrderStatusStream";

/** Same EventSource double as useSse.test.ts / OrderDetailPage.test.tsx. */
class MockEventSource {
  static instances: MockEventSource[] = [];
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
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

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

const fulfillment = (status: string) => ({
  mode: "AUTO",
  provider: "DIGIFLAZZ",
  status,
  payment_status: "PAID",
  can_edit_customer_data: false,
});

describe("useOrderStatusStream", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", MockEventSource);
    MockEventSource.instances = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["SUCCESS", "CANCELLED", "FAILED"])(
    "closes the stream itself on a final %s snapshot, so the browser never reconnects to it, and does not report a disconnect",
    (status) => {
      const queryClient = new QueryClient();
      const { result } = renderHook(() => useOrderStatusStream("ORD1", true), { wrapper: wrapper(queryClient) });
      const source = MockEventSource.instances[0]!;
      act(() => source.emit({ orderStatus: "DELIVERED", digiflazzStatus: null, fulfillment: fulfillment(status) }));
      expect(source.closed).toBe(true);
      // The server ends the response right after that frame; a late error
      // event must not flip the page into "disconnected".
      act(() => source.onerror?.());
      expect(result.current.disconnected).toBe(false);
      expect(MockEventSource.instances).toHaveLength(1);
    },
  );

  it.each(["PROCESSING", "NEEDS_REVIEW", "QUEUED"])("keeps the stream open on a %s snapshot", (status) => {
    const queryClient = new QueryClient();
    const { result } = renderHook(() => useOrderStatusStream("ORD1", true), { wrapper: wrapper(queryClient) });
    const source = MockEventSource.instances[0]!;
    act(() => source.emit({ orderStatus: "PROCESSING", digiflazzStatus: "pending", fulfillment: fulfillment(status) }));
    expect(source.closed).toBe(false);
    act(() => source.onerror?.());
    expect(result.current.disconnected).toBe(true);
  });
});
