import { useState } from "react";
import { Link } from "react-router-dom";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { FilterBar } from "../components/shared/FilterBar";
import { DataTable } from "../components/shared/DataTable";
import { DateInput } from "../components/shared/DateInput";
import { EmptyState } from "../components/shared/EmptyState";
import { Pagination } from "../components/shared/Pagination";
import { formatCurrencyDisplay } from "../components/shared/CurrencyAmount";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Wallet } from "lucide-react";
import { useWalletTransactions, type WalletTransactionRow } from "../hooks/useWalletTransactions";

/**
 * Shop-facing wording for the machine `reason` codes stored in
 * `wallet_transactions` — same shape as AuditPage's ACTION_LABELS, including
 * the humanizing fallback so a reason code added later shows as readable text
 * instead of raw snake_case.
 */
const REASON_LABELS: Record<string, string> = {
  admin_adjust: "Admin adjustment",
  underpaid_refund: "Underpaid refund",
  referral: "Referral payout",
  order_payment: "Order payment",
  order_refund: "Order refund",
  adjust: "Adjustment",
  wallet_topup: "Wallet top-up",
  // Written by `creditOrderToBalance` when a paid order can't be fulfilled and
  // its payment becomes store credit instead. Labelled for what the shop did
  // rather than after the code — the humanizing fallback would render this as
  // "Unfulfilled credit", which reads as a credit that failed.
  unfulfilled_credit: "Credited to balance",
  // Written by `creditOverpaymentToBalance` (task F2) when a buyer paid more than
  // an order asked for and an admin handed the excess back. Labelled for what
  // happened rather than after the code — the humanizing fallback would render
  // this as "Overpaid credit", which reads as a credit that was overpaid.
  overpaid_credit: "Overpayment returned",
};

function humanizeReason(reason: string): string {
  const words = reason.split("_").filter(Boolean).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? humanizeReason(reason);
}

/** A debit, read off the Decimal string the API sent rather than through
 *  `Number()`. No money is computed either way here — the sign only picks a
 *  glyph and a colour — but keeping this file free of `Number()` on money
 *  strings matches the repo's Decimal-only rule and survives amounts too large
 *  for a float to hold exactly. `Decimal#toString()` never emits a leading
 *  "+", so "-" is the only sign that can appear. */
const isDebit = (amount: string): boolean => amount.startsWith("-");

/** A credit: not a debit, and not some spelling of zero ("0", "0.00") — those
 *  get no sign glyph at all. Any digit other than 0 anywhere in the string
 *  means there is magnitude. */
const isCredit = (amount: string): boolean => !isDebit(amount) && /[1-9]/.test(amount);

/** Money display only — the backend already did every Decimal computation.
 *  The sign is what makes the ledger readable at a glance, so a credit keeps
 *  an explicit "+" (formatCurrencyDisplay renders the "−" for debits itself). */
function signedAmount(delta: string, currency: string): string {
  const formatted = formatCurrencyDisplay(delta, currency as "IDR" | "USDT" | "USD");
  return isCredit(delta) ? `+${formatted}` : formatted;
}

const COLUMNS = [
  {
    key: "date",
    header: "Date",
    render: (r: WalletTransactionRow) => (
      <span className="text-xs text-ink-soft whitespace-nowrap">{r.createdAtDisplay ?? "—"}</span>
    ),
  },
  {
    key: "customer",
    header: "Customer",
    render: (r: WalletTransactionRow) => (
      <Link to={`/users/${r.userId}`} className="text-sm text-ink hover:underline">
        {r.customerLabel}
      </Link>
    ),
  },
  {
    key: "reason",
    header: "Reason",
    render: (r: WalletTransactionRow) => (
      <span className="text-sm text-ink" title={r.reason}>
        {reasonLabel(r.reason)}
      </span>
    ),
  },
  {
    key: "delta",
    header: "Amount",
    render: (r: WalletTransactionRow) => (
      <span className={`font-mono text-sm ${isDebit(r.delta) ? "text-rust" : "text-grass-dark"}`}>
        {signedAmount(r.delta, r.currency)}
      </span>
    ),
  },
  {
    key: "balanceAfter",
    header: "Balance After",
    render: (r: WalletTransactionRow) => (
      <span className="font-mono text-sm">{formatCurrencyDisplay(r.balanceAfter, r.currency as "IDR" | "USDT" | "USD")}</span>
    ),
  },
  {
    key: "currency",
    header: "Currency",
    render: (r: WalletTransactionRow) => <span className="text-xs text-ink-soft">{r.currency}</span>,
  },
  {
    key: "order",
    header: "Order",
    render: (r: WalletTransactionRow) =>
      r.orderId != null ? (
        <Link to={`/orders/${r.orderId}`} className="font-mono text-xs text-ink hover:underline">
          #{r.orderId}
        </Link>
      ) : (
        <span className="text-xs text-ink-soft">—</span>
      ),
  },
  {
    key: "note",
    header: "Note",
    render: (r: WalletTransactionRow) => (
      <span className="block max-w-[220px] truncate text-xs text-ink-soft">{r.note || "—"}</span>
    ),
  },
];

/**
 * Every wallet movement in the shop, not one customer at a time — this is
 * where a shop owner watches top-up money arrive. Read-only: nothing on this
 * page mutates state.
 */
export function WalletTransactionsPage() {
  const [page, setPage] = useState(1);
  const [reason, setReason] = useState("");
  const [currency, setCurrency] = useState("");
  const [userId, setUserId] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  // Text/date inputs only take effect on Apply (same as AuditPage); the two
  // dropdowns apply immediately, like the Payments page's filters.
  const [applied, setApplied] = useState({ userId: "", since: "", until: "" });

  const { data, isLoading, isError } = useWalletTransactions({ page, reason, currency, ...applied });

  function applyFilters() {
    setPage(1);
    setApplied({ userId, since, until });
  }

  function clearFilters() {
    setPage(1);
    setReason("");
    setCurrency("");
    setUserId("");
    setSince("");
    setUntil("");
    setApplied({ userId: "", since: "", until: "" });
  }

  return (
    <PageLayout title="Wallet Transactions">
      <PageHeader title="Wallet Transactions" description="Every credit and debit across all customer wallets." />

      <div className="flex flex-col gap-4">
        <FilterBar onApply={applyFilters} onClear={clearFilters}>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-ink-soft">Reason</label>
            <Select
              value={reason || "_all_"}
              onValueChange={v => { setReason(v === "_all_" ? "" : v); setPage(1); }}
            >
              <SelectTrigger className="w-44" aria-label="Reason"><SelectValue placeholder="All reasons" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="_all_">All</SelectItem>
                {(data?.reasons ?? []).map(r => (
                  <SelectItem key={r} value={r}>{reasonLabel(r)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-ink-soft">Currency</label>
            <Select
              value={currency || "_all_"}
              onValueChange={v => { setCurrency(v === "_all_" ? "" : v); setPage(1); }}
            >
              <SelectTrigger className="w-32" aria-label="Currency"><SelectValue placeholder="All" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="_all_">All</SelectItem>
                <SelectItem value="IDR">IDR</SelectItem>
                <SelectItem value="USDT">USDT</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Input
            placeholder="Customer ID"
            value={userId}
            onChange={e => setUserId(e.target.value)}
            className="w-32"
          />
          <DateInput value={since} onChange={e => setSince(e.target.value)} className="w-36" aria-label="From date" />
          <DateInput value={until} onChange={e => setUntil(e.target.value)} className="w-36" aria-label="To date" />
        </FilterBar>

        {isError && <p className="text-sm text-rust">Failed to load wallet transactions.</p>}

        <Card>
          <CardContent>
            <DataTable
              nested
              columns={COLUMNS}
              data={data?.rows ?? []}
              isLoading={isLoading && !data}
              keyExtractor={r => r.id}
              empty={
                <EmptyState
                  icon={Wallet}
                  title="No wallet movements found"
                  description="Top-ups, refunds and wallet payments will appear here as they happen."
                />
              }
            />
          </CardContent>
        </Card>

        {data && (
          <Pagination
            page={page}
            pageSize={data.pageSize}
            total={data.total}
            onPageChange={setPage}
          />
        )}
      </div>
    </PageLayout>
  );
}
