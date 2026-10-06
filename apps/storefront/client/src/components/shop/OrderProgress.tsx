import { Check, Circle, CircleAlert, Clock, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import type { OrderFulfillment } from "../../api/types";
import { t } from "../../lib/i18n";
import { fulfillmentPresentation } from "../../lib/orderFulfillment";
import Card from "../ui/Card";

export default function OrderProgress({ fulfillment, children }: { fulfillment: OrderFulfillment; children?: ReactNode }) {
  const state = fulfillmentPresentation(fulfillment);
  const paid = fulfillment.payment_status === "PAID";
  const Icon = state.active ? LoaderCircle : state.complete ? Check : state.problem ? CircleAlert : Clock;
  const tone = state.complete ? "text-grass-dark" : state.problem ? "text-amberx" : "text-pine";
  const steps = [
    { key: "web.order_progress_payment", done: paid, current: fulfillment.payment_status === "PENDING", problem: !paid && state.problem },
    { key: "web.order_progress_processing", done: state.complete, current: paid && state.active, problem: paid && state.problem },
    { key: "web.order_progress_completed", done: state.complete, current: false, problem: false },
  ];
  return (
    <Card className="min-w-0 bg-pine-tint/40">
      <div role="status" aria-live="polite" className="flex items-start gap-3">
        <Icon aria-hidden="true" className={`mt-0.5 h-5 w-5 shrink-0 ${tone} ${state.active ? "animate-spin motion-reduce:animate-none" : ""}`} />
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink">{t(state.titleKey)}</h2>
          <p className="mt-1 text-sm text-ink-soft">{t(state.bodyKey)}</p>
        </div>
      </div>
      <ol aria-label={t("web.order_progress")} className="mt-4 grid grid-cols-3 gap-2 border-t border-line pt-4">
        {steps.map((step) => {
          const StepIcon = step.done ? Check : step.problem ? CircleAlert : step.current && paid ? LoaderCircle : Circle;
          return (
            <li key={step.key} aria-current={step.current && !state.problem ? "step" : undefined} className="flex min-w-0 flex-col items-center gap-2 text-center text-xs sm:text-sm">
              <span aria-hidden="true" className={`grid h-8 w-8 place-items-center rounded-full ${step.done ? "bg-grass-tint text-grass-dark" : step.problem ? "bg-amberx-tint text-amberx" : step.current ? "bg-pine-tint text-pine" : "bg-sand text-ink-faint"}`}>
                <StepIcon className={`h-4 w-4 ${step.current && paid ? "animate-spin motion-reduce:animate-none" : ""}`} />
              </span>
              <span className="break-words text-ink-soft">{t(step.key)}</span>
            </li>
          );
        })}
      </ol>
      {children && <div className="mt-3">{children}</div>}
    </Card>
  );
}
