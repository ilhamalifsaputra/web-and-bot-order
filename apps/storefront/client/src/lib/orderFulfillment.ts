import type { OrderDetailData, OrderFulfillment } from "../api/types";

/** Presentation only: every transition comes from the canonical API state. */
export function fulfillmentPresentation(fulfillment: OrderFulfillment) {
  const topUp = fulfillment.provider === "DIGIFLAZZ";
  const active = ["QUEUED", "SUBMITTING", "PROCESSING"].includes(fulfillment.status);
  const complete = fulfillment.status === "SUCCESS";
  const problem = ["FAILED", "NEEDS_REVIEW", "CANCELLED"].includes(fulfillment.status);
  const base = { active, complete, problem, badge: "processing", titleKey: "web.fulfillment_not_started_title", bodyKey: "web.fulfillment_not_started_body" };

  if (fulfillment.status === "CANCELLED" && fulfillment.payment_status === "PENDING") {
    return { ...base, active: false, badge: "cancelled", titleKey: "web.status_chip_cancelled", bodyKey: "web.fulfillment_cancelled_body" };
  }

  if (fulfillment.payment_status !== "PAID") {
    switch (fulfillment.payment_status) {
      case "PENDING": return { ...base, active: false, badge: "waiting_payment", titleKey: "web.fulfillment_badge_waiting_payment", bodyKey: "web.fulfillment_badge_waiting_payment" };
      case "FAILED": return { ...base, active: false, problem: true, badge: "failed", titleKey: "status.label.failed", bodyKey: "web.fulfillment_payment_failed_body" };
      case "EXPIRED": return { ...base, active: false, problem: true, badge: "cancelled", titleKey: "web.status_chip_cancelled", bodyKey: "web.fulfillment_payment_expired_body" };
      case "REFUNDED": return { ...base, active: false, problem: true, badge: "refunded", titleKey: "status.label.refunded", bodyKey: "web.fulfillment_refunded_body" };
    }
  }

  if (fulfillment.mode === "MANUAL" && ["NOT_STARTED", "QUEUED", "SUBMITTING", "PROCESSING"].includes(fulfillment.status)) {
    return { ...base, titleKey: "web.order_processing_title", bodyKey: "web.order_processing_body" };
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
