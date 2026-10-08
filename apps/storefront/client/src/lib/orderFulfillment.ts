import type { OrderDetailData, OrderFulfillment } from "../api/types";

/** Presentation only: every transition comes from the canonical API state. */
export function fulfillmentPresentation(fulfillment: OrderFulfillment) {
  const legacy = legacyFulfillmentPresentation(fulfillment);
  const presentation = fulfillment.presentation;
  if (!presentation) return legacy;
  const complete = ["SUCCESS", "WALLET_CREDITED", "CREDITED"].includes(presentation.phase);
  const problem = ["UNDERPAID", "FAILED", "REVIEW", "CANCELLED"].includes(presentation.phase);
  const badge = complete ? "completed" : presentation.phase === "UNDERPAID" ? "underpaid" : presentation.phase === "REVIEW" ? "under_review" : legacy.badge;
  return { ...legacy, active: presentation.spinner, complete, problem, badge, titleKey: presentation.titleKey, bodyKey: presentation.bodyKey, progress: presentation.progress };
}

function legacyFulfillmentPresentation(fulfillment: OrderFulfillment) {
  const topUp = fulfillment.provider === "DIGIFLAZZ";
  const active = ["QUEUED", "SUBMITTING", "PROCESSING"].includes(fulfillment.status);
  const complete = fulfillment.status === "SUCCESS";
  const problem = ["FAILED", "NEEDS_REVIEW", "CANCELLED"].includes(fulfillment.status);
  // `waiting`: in progress but nothing automatic is running (a manual order
  // awaiting preparation, possibly for hours) — a static clock, never a spinner.
  const base = { active, waiting: false, complete, problem, progress: null as number | null, badge: "processing", titleKey: "web.fulfillment_not_started_title", bodyKey: "web.fulfillment_not_started_body" };

  if (fulfillment.status === "CANCELLED" && fulfillment.payment_status === "PENDING") {
    return { ...base, active: false, badge: "cancelled", titleKey: "web.status_chip_cancelled", bodyKey: "web.fulfillment_cancelled_body" };
  }

  if (fulfillment.payment_status !== "PAID") {
    switch (fulfillment.payment_status) {
      case "PAYMENT_DETECTED":
      case "VERIFYING": return { ...base, active: true, badge: "processing", titleKey: "web.status_confirming", bodyKey: "web.pay_confirming_sub" };
      case "UNDERPAID": return { ...base, active: false, problem: true, badge: "underpaid", titleKey: "transaction.underpaid_title", bodyKey: "transaction.underpaid_body" };
      case "PENDING": return { ...base, active: false, badge: "waiting_payment", titleKey: "web.fulfillment_badge_waiting_payment", bodyKey: "web.fulfillment_badge_waiting_payment" };
      case "FAILED": return { ...base, active: false, problem: true, badge: "failed", titleKey: "status.label.failed", bodyKey: "web.fulfillment_payment_failed_body" };
      case "EXPIRED": return { ...base, active: false, problem: true, badge: "cancelled", titleKey: "web.status_chip_cancelled", bodyKey: "web.fulfillment_payment_expired_body" };
      case "REFUNDED": return { ...base, active: false, problem: true, badge: "refunded", titleKey: "status.label.refunded", bodyKey: "web.fulfillment_refunded_body" };
    }
  }

  if (fulfillment.mode === "MANUAL" && ["NOT_STARTED", "QUEUED", "SUBMITTING", "PROCESSING"].includes(fulfillment.status)) {
    return { ...base, active: false, waiting: true, titleKey: "web.order_processing_title", bodyKey: "web.order_processing_body" };
  }

  switch (fulfillment.status) {
    case "NOT_STARTED": return base;
    case "QUEUED": return { ...base, titleKey: topUp ? "web.fulfillment_queued_title" : "web.fulfillment_generic_processing_title", bodyKey: "web.fulfillment_queued_body" };
    case "SUBMITTING": return { ...base, titleKey: "web.fulfillment_submitting_title", bodyKey: "web.fulfillment_submitting_body" };
    case "PROCESSING": return {
      ...base,
      titleKey: topUp ? "web.fulfillment_processing_title" : "web.fulfillment_generic_processing_title",
      bodyKey: "web.fulfillment_processing_body",
    };
    case "SUCCESS": return { ...base, badge: "completed", titleKey: topUp ? "web.fulfillment_success_title" : "web.fulfillment_generic_success_title", bodyKey: "web.fulfillment_success_body" };
    case "FAILED": return { ...base, badge: "failed", titleKey: topUp ? "web.fulfillment_failed_title" : "web.fulfillment_generic_failed_title", bodyKey: "web.fulfillment_failed_body" };
    case "NEEDS_REVIEW": return { ...base, badge: "under_review", titleKey: "web.fulfillment_review_title", bodyKey: "web.fulfillment_review_body" };
    case "CANCELLED": return { ...base, badge: "cancelled", titleKey: "web.status_chip_cancelled", bodyKey: "web.fulfillment_cancelled_body" };
  }
}

/** Continue observing payment and any order still awaiting fulfillment. */
export function isOrderLive(data: OrderDetailData | undefined): boolean {
  if (!data) return false;
  return data.pending_payment || data.processing || ["PENDING_PAYMENT", "PENDING_VERIFICATION", "PAID", "PROCESSING"].includes(data.order.status.toUpperCase());
}
