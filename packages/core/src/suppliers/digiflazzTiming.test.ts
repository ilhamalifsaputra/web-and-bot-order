import { describe, it, expect, vi } from "vitest";
import { DigiflazzTimingEvent, elapsedMs, logDigiflazzTimingEvent } from "./digiflazzTiming";

describe("elapsedMs", () => {
  it("returns the gap in milliseconds between two dates", () => {
    expect(elapsedMs(new Date("2026-10-07T10:00:00.000Z"), new Date("2026-10-07T10:00:01.250Z"))).toBe(1250);
  });

  it("returns undefined when either end is missing or invalid, so the field is simply omitted", () => {
    expect(elapsedMs(null, new Date())).toBeUndefined();
    expect(elapsedMs(new Date(), undefined)).toBeUndefined();
    expect(elapsedMs(new Date("not a date"), new Date())).toBeUndefined();
  });
});

describe("logDigiflazzTimingEvent", () => {
  it("logs the event fields at info level with the sentence, dropping undefined fields", () => {
    const sink = { info: vi.fn() };
    logDigiflazzTimingEvent(
      {
        event: DigiflazzTimingEvent.FULFILLMENT_CLAIMED,
        orderId: 7,
        orderCode: "ORD-7",
        trigger: "direct",
        claimKind: "fresh",
        attempt: 1,
        delayFromPaymentMs: undefined,
      },
      "Claimed order ORD-7 for its first Digiflazz request.",
      sink,
    );
    expect(sink.info).toHaveBeenCalledTimes(1);
    const [fields, message] = sink.info.mock.calls[0]!;
    expect(fields).toEqual({ event: "fulfillment.claimed", orderId: 7, orderCode: "ORD-7", trigger: "direct", claimKind: "fresh", attempt: 1 });
    expect(Object.keys(fields as object)).not.toContain("delayFromPaymentMs");
    expect(message).toBe("Claimed order ORD-7 for its first Digiflazz request.");
  });

  it("never throws, even when the logger itself throws", () => {
    const sink = { info: vi.fn(() => { throw new Error("log transport down"); }) };
    expect(() =>
      logDigiflazzTimingEvent(
        { event: DigiflazzTimingEvent.ORDER_COMPLETED, orderId: 1, orderCode: "ORD-1", outcome: "Sukses" },
        "Order ORD-1 completed.",
        sink,
      ),
    ).not.toThrow();
  });

  it("uses the documented event names", () => {
    expect(Object.values(DigiflazzTimingEvent).sort()).toEqual(
      [
        "digiflazz.request",
        "digiflazz.response",
        "digiflazz.webhook_received",
        "fulfillment.claimed",
        "order.completed",
        "payment.confirmed",
      ],
    );
  });
});
