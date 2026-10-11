import { Check, Circle, CircleAlert, Clock, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import type { OrderFulfillment, Underpayment } from "../../api/types";
import { t } from "../../lib/i18n";
import { fulfillmentPresentation } from "../../lib/orderFulfillment";
import Card from "../ui/Card";
import TransactionStatus from "./TransactionStatus";

export default function OrderProgress({ fulfillment, underpayment, children }: { fulfillment: OrderFulfillment; underpayment?: Underpayment | null; children?: ReactNode }) {
  if (fulfillment.presentation) {
    return <Card className="min-w-0 bg-pine-tint/40"><TransactionStatus presentation={fulfillment.presentation} underpayment={underpayment}>{children}</TransactionStatus></Card>;
  }
  const state = fulfillmentPresentation(fulfillment);
  const paid = fulfillment.payment_status === "PAID";
  const Icon = progressIcon(state);
  const tone = progressTone(state);
  const steps = [
    { key: "web.order_progress_payment", done: paid, current: fulfillment.payment_status === "PENDING", problem: !paid && state.problem },
    { key: "web.order_progress_processing", done: state.complete, current: paid && (state.active || state.waiting), problem: paid && state.problem },
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
        {steps.map((step) => <ProgressStep key={step.key} step={step} paid={paid} active={state.active} problem={state.problem} />)}
      </ol>
      {children && <div className="mt-3">{children}</div>}
    </Card>
  );
}

function ProgressStep({ step, paid, active, problem }: { step: { key: string; done: boolean; current: boolean; problem: boolean }; paid: boolean; active: boolean; problem: boolean }) {
  const spinning = step.current && paid && active;
  const StepIcon = progressStepIcon(step, paid, spinning);
  return (
    <li key={step.key} aria-current={step.current && !problem ? "step" : undefined} className="flex min-w-0 flex-col items-center gap-2 text-center text-xs sm:text-sm">
      <span aria-hidden="true" className={`grid h-8 w-8 place-items-center rounded-full ${progressStepTone(step)}`}>
        <StepIcon className={`h-4 w-4 ${spinning ? "animate-spin motion-reduce:animate-none" : ""}`} />
      </span>
      <span className="break-words text-ink-soft">{t(step.key)}</span>
    </li>
  );
}

function progressIcon(state: ReturnType<typeof fulfillmentPresentation>) {
  if (state.active) return LoaderCircle;
  if (state.complete) return Check;
  if (state.problem) return CircleAlert;
  return Clock;
}
function progressTone(state: ReturnType<typeof fulfillmentPresentation>) {
  if (state.complete) return "text-grass-dark";
  if (state.problem) return "text-amberx";
  return "text-pine";
}
type ProgressStepState = { done: boolean; problem: boolean; current: boolean };
function progressStepIcon(step: ProgressStepState, paid: boolean, spinning: boolean) {
  if (step.done) return Check;
  if (step.problem) return CircleAlert;
  if (spinning) return LoaderCircle;
  if (step.current && paid) return Clock;
  return Circle;
}
function progressStepTone(step: ProgressStepState) {
  if (step.done) return "bg-grass-tint text-grass-dark";
  if (step.problem) return "bg-amberx-tint text-amberx";
  if (step.current) return "bg-pine-tint text-pine";
  return "bg-sand text-ink-faint";
}
