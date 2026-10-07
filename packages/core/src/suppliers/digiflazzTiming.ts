/**
 * The timing events of a paid Digiflazz order, from payment to completion,
 * as one field contract (documented with a worked example in docs/LOGGING.md,
 * "Digiflazz timing events"). Each is one `logger.info(fields, sentence)` line
 * with an `event` name; grep `"event":"order.completed"` to see where time went.
 *
 * Every duration is computed from columns the order already has (`paidAt`,
 * `digiflazzDispatchedAt`, `deliveredAt`) or the clock around the HTTP call —
 * no schema of its own. A duration whose start is missing (a legacy order with
 * no `paidAt`) is omitted, not reported as 0.
 *
 * Observability only: logDigiflazzTimingEvent never throws, so a broken log
 * transport can never break a dispatch or a payment. Never put secrets in
 * these fields — no API key, signature, webhook secret, request or callback
 * body, or player/customer data (CLAUDE.md, "Never log secrets").
 */
import { logger } from "../logger";
import type { DigiflazzRequestErrorKind, DigiflazzStatus } from "./digiflazz";

export const DigiflazzTimingEvent = {
  /** settlePaidOrder moved a paid order to PROCESSING (its `paidAt` is the
   *  anchor every later "from payment" duration is measured from). */
  PAYMENT_CONFIRMED: "payment.confirmed",
  /** A dispatcher won the atomic claim and is about to call Digiflazz. */
  FULFILLMENT_CLAIMED: "fulfillment.claimed",
  /** The /transaction request is being sent. */
  DIGIFLAZZ_REQUEST: "digiflazz.request",
  /** The /transaction request returned or failed. */
  DIGIFLAZZ_RESPONSE: "digiflazz.response",
  /** A Digiflazz webhook passed its signature check and matched an order. */
  DIGIFLAZZ_WEBHOOK_RECEIVED: "digiflazz.webhook_received",
  /** The order reached its final Digiflazz outcome (delivered, or failed and
   *  handed to an admin). */
  ORDER_COMPLETED: "order.completed",
} as const;

export type DigiflazzTimingEventName = (typeof DigiflazzTimingEvent)[keyof typeof DigiflazzTimingEvent];

interface OrderRef {
  /** `Order.id` — the join key. */
  orderId: number;
  /** `Order.orderCode` — what a human searches for; also Digiflazz's ref id. */
  orderCode: string;
}

export interface PaymentConfirmedFields extends OrderRef {
  event: typeof DigiflazzTimingEvent.PAYMENT_CONFIRMED;
  paymentMethod: string | null;
  currency: string;
  /** ISO-8601 UTC. */
  paidAt?: string;
  fulfillmentProvider: string;
}

export interface FulfillmentClaimedFields extends OrderRef {
  event: typeof DigiflazzTimingEvent.FULFILLMENT_CLAIMED;
  /** "direct": the instant dispatch right after payment; "cron": the 5-second recovery job. */
  trigger: "direct" | "cron";
  /** "fresh": the first request for this order; "recheck": a repeat with the same ref id. */
  claimKind: "fresh" | "recheck";
  /** 1 for the first request, then 2, 3, ... */
  attempt: number;
  /** Claim time minus `paidAt`. */
  delayFromPaymentMs?: number;
}

export interface DigiflazzRequestFields extends OrderRef {
  event: typeof DigiflazzTimingEvent.DIGIFLAZZ_REQUEST;
  /** Always the order code. */
  refId: string;
  /** The Digiflazz buyer SKU code. */
  skuCode: string;
  attempt: number;
}

export interface DigiflazzResponseFields extends OrderRef {
  event: typeof DigiflazzTimingEvent.DIGIFLAZZ_RESPONSE;
  refId: string;
  /** Digiflazz's normalized status, or "error" when no answer was usable. */
  status: DigiflazzStatus | "error";
  /** Wall time of the createTransaction call. */
  durationMs: number;
  /** Only for status "error": the request error's kind ("unknown" for an untyped error). */
  errorKind?: DigiflazzRequestErrorKind | "unknown";
  /** Only for status "error": whether the error is eligible for another try
   * with the same ref id. A recheck error always is, within the 24h backoff
   * window (past it the order goes to an admin); on a fresh dispatch only a
   * permanent http_4xx is not. */
  retryable?: boolean;
}

export interface DigiflazzWebhookReceivedFields extends OrderRef {
  event: typeof DigiflazzTimingEvent.DIGIFLAZZ_WEBHOOK_RECEIVED;
  /** The verified ref id from the signed body. */
  refId: string;
  /** The status the callback reports (the route still re-checks it live). */
  callbackStatus: DigiflazzStatus;
  /** Receipt time minus `digiflazzDispatchedAt`. */
  msSinceDispatch?: number;
}

export interface OrderCompletedFields extends OrderRef {
  event: typeof DigiflazzTimingEvent.ORDER_COMPLETED;
  outcome: "Sukses" | "Gagal";
  /** First dispatch (`digiflazzDispatchedAt`) minus `paidAt`. */
  paymentToFulfillmentMs?: number;
  /** Duration of the createTransaction call that produced this outcome. */
  digiflazzApiDurationMs?: number;
  /** Completion minus first dispatch: how long Digiflazz held the order. */
  digiflazzPendingDurationMs?: number;
  /** Completion minus `paidAt`: the buyer's total wait. */
  paymentToCompletionMs?: number;
}

export type DigiflazzTimingFields =
  | PaymentConfirmedFields
  | FulfillmentClaimedFields
  | DigiflazzRequestFields
  | DigiflazzResponseFields
  | DigiflazzWebhookReceivedFields
  | OrderCompletedFields;

/** `to - from` in milliseconds, or undefined when either end is missing or invalid. */
export function elapsedMs(from: Date | null | undefined, to: Date | null | undefined): number | undefined {
  if (!from || !to) return undefined;
  const ms = to.getTime() - from.getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

/** Log one timing event at info level, dropping undefined fields. Never throws. */
export function logDigiflazzTimingEvent(
  fields: DigiflazzTimingFields,
  message: string,
  sink: { info: (fields: object, message: string) => unknown } = logger,
): void {
  try {
    const defined = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
    sink.info(defined, message);
  } catch {
    // Observability must never break the money path.
  }
}
