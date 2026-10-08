import { Check, CircleAlert, Clock, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import type { CustomerProgress, Underpayment } from "../../api/types";
import { t } from "../../lib/i18n";
import { formatOrderAmount } from "../../lib/format";

/** Render the server's phase without deriving payment facts or timing progress. */
export default function TransactionStatus({ presentation, underpayment, children }: {
  presentation: CustomerProgress;
  underpayment?: Underpayment | null;
  children?: ReactNode;
}) {
  const complete = ["SUCCESS", "WALLET_CREDITED", "CREDITED"].includes(presentation.phase);
  const problem = ["UNDERPAID", "REVIEW", "FAILED"].includes(presentation.phase);
  const Icon = presentation.spinner ? LoaderCircle : complete ? Check : problem ? CircleAlert : Clock;
  return (
    <div className="min-w-0">
      <div role="status" aria-live="polite" className="flex items-start gap-3">
        <Icon aria-hidden="true" className={`mt-0.5 h-5 w-5 shrink-0 ${problem ? "text-amberx" : complete ? "text-grass-dark" : "text-pine"} ${presentation.spinner ? "animate-spin motion-reduce:animate-none" : ""}`} />
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink">{t(presentation.titleKey)}</h2>
          <p className="mt-1 text-sm text-ink-soft">{t(presentation.bodyKey)}</p>
        </div>
      </div>
      {presentation.progress !== null && (
        <div className="mt-4">
          <div role="progressbar" aria-label={t("web.order_progress")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={presentation.progress} className="h-2 overflow-hidden rounded-full bg-sand">
            <div className="h-full rounded-full bg-pine" style={{ width: `${presentation.progress}%` }} />
          </div>
          <p className="mt-1 text-right text-xs text-ink-soft">{presentation.progress}%</p>
        </div>
      )}
      {underpayment && (
        <dl className="mt-4 space-y-2 text-sm">
          <div className="flex flex-wrap justify-between gap-2"><dt>{t("transaction.required")}</dt><dd className="font-medium">{formatOrderAmount(underpayment.required, underpayment.currency)}</dd></div>
          <div className="flex flex-wrap justify-between gap-2"><dt>{t("transaction.received")}</dt><dd className="font-medium">{underpayment.received === null ? t("transaction.received_unknown") : formatOrderAmount(underpayment.received, underpayment.currency)}</dd></div>
        </dl>
      )}
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}
