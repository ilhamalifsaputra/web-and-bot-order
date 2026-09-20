import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { FilterBar } from "../components/shared/FilterBar";
import { DataTable } from "../components/shared/DataTable";
import { DateInput } from "../components/shared/DateInput";
import { EmptyState } from "../components/shared/EmptyState";
import { Pagination } from "../components/shared/Pagination";
import { StatusBadge } from "../components/shared/StatusBadge";
import { formatCurrencyDisplay } from "../components/shared/CurrencyAmount";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Landmark, Plus, Trash2, TriangleAlert } from "lucide-react";
import { apiPost } from "../api/client";
import { describeError } from "../lib/errorMessages";
import { useSettlements, type SettlementRow } from "../hooks/useSettlements";

/** The currencies `formatCurrencyDisplay` accepts — the server sends only these
 *  two, and a row in anything else could not have been recorded. */
type MoneyCurrency = "IDR" | "USDT" | "USD";

/**
 * The gateways a payout batch can come from. Mirrors `PaymentMethod`
 * (@app/core/enums) minus WALLET, which never pays anything out — an order paid
 * from wallet credit involves no external provider and so can never appear on a
 * provider's statement. The SPA keeps its own copies of server enums (same
 * convention as api/types.ts's mirrored types); the authoritative list is the
 * one `recordSettlement` validates against, never this one.
 */
const PROVIDERS = [
  "TOKOPAY",
  "PAYDISINI",
  "NOWPAYMENTS",
  "BINANCE_PAY",
  "BINANCE_INTERNAL",
  "BYBIT",
  "BYBIT_BSC",
];

/** One statement line an admin is entering, before it is submitted. */
interface DraftLine {
  /** Local key only — the server assigns real ids. */
  key: number;
  amount: string;
  providerTransactionId: string;
}

const emptyForm = {
  provider: "TOKOPAY",
  batchReference: "",
  settlementDate: "",
  currency: "IDR",
  grossAmount: "",
  feeAmount: "",
  netAmount: "",
};

/**
 * Provider payout batches — the record of a gateway actually paying the shop
 * (task F1).
 *
 * Why this page exists rather than a report: until a batch is recorded, the
 * ledger has every sale sitting in `provider_clearing` (money the gateway has
 * collected but not paid over) and nothing ever draining it, so `cash.*` reads
 * as monotonically negative and neither account is a usable cash position. An
 * admin entering a provider's own statement here is what closes that loop.
 *
 * All the arithmetic is the server's. This form deliberately does NOT derive net
 * from gross minus fee, or fee from gross minus net: `Settlement.netAmount` is
 * stored rather than computed precisely so a provider's own statement can be
 * recorded verbatim, and the service refuses a batch whose three figures
 * disagree rather than picking one to believe. An admin copying three numbers off
 * a statement and being told they do not add up is the intended experience — a
 * form that auto-filled the third would hide the provider's own arithmetic error.
 * The only client-side check is that the required boxes are non-empty, so a
 * refusal always comes from the one place that owns the rule.
 */
export function SettlementsPage() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [providerFilter, setProviderFilter] = useState("");
  const [currencyFilter, setCurrencyFilter] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [nextLineKey, setNextLineKey] = useState(1);

  const { data, isLoading, isError } = useSettlements({
    page,
    provider: providerFilter,
    currency: currencyFilter,
  });

  const rows = useMemo(() => data?.settlements ?? [], [data]);
  /** A batch with no ledger posting is the one thing on this page that is wrong
   *  rather than merely informational, so it gets a banner and not just a cell. */
  const unpostedCount = rows.filter((row) => row.postingId === null).length;

  const record = useMutation({
    mutationFn: () =>
      apiPost<{ ok: boolean; settlementId: number; posted: boolean }>("/api/settlements", {
        provider: form.provider,
        batchReference: form.batchReference.trim() || null,
        settlementDate: form.settlementDate,
        currency: form.currency,
        // Sent as the strings the admin typed. Never `Number(...)`: a float
        // round-trip is how an amount loses its last digits, and the server
        // parses these with Decimal.
        grossAmount: form.grossAmount.trim(),
        feeAmount: form.feeAmount.trim() || "0",
        netAmount: form.netAmount.trim(),
        lines: lines
          .filter((line) => line.amount.trim() !== "")
          .map((line) => ({
            amount: line.amount.trim(),
            providerTransactionId: line.providerTransactionId.trim() || null,
          })),
      }),
    onSuccess: (result) => {
      setDialogOpen(false);
      setForm(emptyForm);
      setLines([]);
      void qc.invalidateQueries({ queryKey: ["settlements"] });
      if (result.posted) {
        toast.success("Settlement recorded, and the books now show the money as received.");
      } else {
        // The batch row saved but nothing was booked — the shop's chart of
        // accounts is missing an account this currency needs. Said plainly,
        // because the cash position stays understated until it is fixed.
        toast.warning(
          "Settlement recorded, but it could NOT be booked to the ledger — the shop's chart of accounts is missing an account for this currency. Ask a developer to run the chart-of-accounts setup, then record this batch again.",
        );
      }
    },
    onError: (e: Error) => toast.error(describeError(e)),
  });

  const canSubmit =
    form.settlementDate.trim() !== "" &&
    form.grossAmount.trim() !== "" &&
    form.netAmount.trim() !== "" &&
    !record.isPending;

  function addLine() {
    setLines((prev) => [...prev, { key: nextLineKey, amount: "", providerTransactionId: "" }]);
    setNextLineKey((k) => k + 1);
  }

  function updateLine(key: number, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function clearFilters() {
    setPage(1);
    setProviderFilter("");
    setCurrencyFilter("");
  }

  const COLUMNS = [
    {
      key: "date",
      header: "Settled",
      render: (row: SettlementRow) => (
        <span className="whitespace-nowrap text-sm text-ink">{row.settlementDateDisplay ?? "—"}</span>
      ),
    },
    {
      key: "provider",
      header: "Provider",
      render: (row: SettlementRow) => (
        <div className="flex flex-col gap-0.5">
          <span className="text-sm text-ink">{row.provider}</span>
          <span className="font-mono text-xs text-ink-soft">{row.batchReference ?? `#${row.id}`}</span>
        </div>
      ),
    },
    {
      key: "gross",
      header: "Collected",
      render: (row: SettlementRow) => (
        <span className="font-mono text-sm">
          {formatCurrencyDisplay(row.grossAmount, row.currency as MoneyCurrency)}
        </span>
      ),
    },
    {
      key: "fee",
      header: "Provider's Cut",
      render: (row: SettlementRow) => (
        <span className="font-mono text-sm text-rust">
          {formatCurrencyDisplay(row.feeAmount, row.currency as MoneyCurrency)}
        </span>
      ),
    },
    {
      key: "net",
      header: "Received",
      render: (row: SettlementRow) => (
        <span className="font-mono text-sm font-medium text-grass-dark">
          {formatCurrencyDisplay(row.netAmount, row.currency as MoneyCurrency)}
        </span>
      ),
    },
    {
      key: "lines",
      header: "Statement Lines",
      render: (row: SettlementRow) =>
        row.lineCount === 0 ? (
          <span className="text-xs text-ink-soft">None entered</span>
        ) : (
          <span className="text-xs text-ink-soft">
            {row.matchedLineCount} of {row.lineCount} matched to a payment
          </span>
        ),
    },
    {
      key: "status",
      header: "Status",
      render: (row: SettlementRow) => (
        <div className="flex flex-col items-start gap-1">
          <StatusBadge status={row.status} />
          {row.postingId === null && (
            <span className="text-xs text-rust">Not booked to the ledger</span>
          )}
        </div>
      ),
    },
  ];

  return (
    <PageLayout title="Settlements">
      <PageHeader
        title="Settlements"
        description="Each time a payment provider pays the shop, record the batch here so the books show the money as received rather than still sitting with the provider."
        actions={
          <Button size="sm" onClick={() => setDialogOpen(true)}>
            <Plus className="h-4 w-4" />
            Record Settlement
          </Button>
        }
      />

      <div className="flex flex-col gap-4">
        <FilterBar onClear={providerFilter || currencyFilter ? clearFilters : undefined}>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-ink-soft">Provider</label>
            <Select
              value={providerFilter || "_all_"}
              onValueChange={(v) => {
                setProviderFilter(v === "_all_" ? "" : v);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-48" aria-label="Provider">
                <SelectValue placeholder="All providers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_all_">All</SelectItem>
                {(data?.providers ?? []).map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-ink-soft">Currency</label>
            <Select
              value={currencyFilter || "_all_"}
              onValueChange={(v) => {
                setCurrencyFilter(v === "_all_" ? "" : v);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-32" aria-label="Currency">
                <SelectValue placeholder="All" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_all_">All</SelectItem>
                {(data?.currencies ?? ["IDR", "USDT"]).map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </FilterBar>

        {isError && <p className="text-sm text-rust">Failed to load settlements.</p>}

        {unpostedCount > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-rust/40 bg-rust/5 px-3 py-2 text-sm text-ink">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-rust" />
            <span>
              {unpostedCount === 1
                ? "One batch on this page was recorded but never booked to the ledger, so the shop's cash position is understated by its amount."
                : `${unpostedCount} batches on this page were recorded but never booked to the ledger, so the shop's cash position is understated by their amounts.`}{" "}
              This happens when the chart of accounts is missing an account — ask a developer to run
              the chart-of-accounts setup, then record those batches again.
            </span>
          </div>
        )}

        <Card>
          <CardContent>
            <DataTable
              nested
              columns={COLUMNS}
              data={rows}
              isLoading={isLoading && !data}
              keyExtractor={(row) => row.id}
              empty={
                <EmptyState
                  icon={Landmark}
                  title="No settlements recorded yet"
                  description="Record a provider's payout statement to show that money as received in the shop's books."
                />
              }
            />
          </CardContent>
        </Card>

        {data && (
          <Pagination page={page} pageSize={data.pageSize} total={data.total} onPageChange={setPage} />
        )}
      </div>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            setForm(emptyForm);
            setLines([]);
          }
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Record a provider payout</DialogTitle>
            <DialogDescription>
              Copy the three amounts straight off the provider's statement. The collected amount must
              equal the provider's cut plus what reached the shop's account — if they don't add up,
              the entry is refused rather than guessed at.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-ink" htmlFor="settlement-provider">
                  Provider
                </label>
                <Select
                  value={form.provider}
                  onValueChange={(v) => setForm((f) => ({ ...f, provider: v }))}
                >
                  <SelectTrigger id="settlement-provider" aria-label="Payout provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVIDERS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-ink" htmlFor="settlement-currency">
                  Currency
                </label>
                <Select
                  value={form.currency}
                  onValueChange={(v) => setForm((f) => ({ ...f, currency: v }))}
                >
                  <SelectTrigger id="settlement-currency" aria-label="Batch currency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(data?.currencies ?? ["IDR", "USDT"]).map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-ink" htmlFor="settlement-date">
                Date the provider settled it
              </label>
              <DateInput
                id="settlement-date"
                value={form.settlementDate}
                onChange={(e) => setForm((f) => ({ ...f, settlementDate: e.target.value }))}
                aria-label="Settlement date"
              />
              <span className="text-xs text-ink-soft">
                The date on the statement, not today — reports for a period read this date.
              </span>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-ink" htmlFor="settlement-reference">
                Statement or payout id (optional)
              </label>
              <Input
                id="settlement-reference"
                value={form.batchReference}
                onChange={(e) => setForm((f) => ({ ...f, batchReference: e.target.value }))}
                placeholder="As the provider prints it"
              />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-ink" htmlFor="settlement-gross">
                  Collected
                </label>
                <Input
                  id="settlement-gross"
                  inputMode="decimal"
                  value={form.grossAmount}
                  onChange={(e) => setForm((f) => ({ ...f, grossAmount: e.target.value }))}
                  placeholder="0"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-ink" htmlFor="settlement-fee">
                  Provider's cut
                </label>
                <Input
                  id="settlement-fee"
                  inputMode="decimal"
                  value={form.feeAmount}
                  onChange={(e) => setForm((f) => ({ ...f, feeAmount: e.target.value }))}
                  placeholder="0"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-ink" htmlFor="settlement-net">
                  Received
                </label>
                <Input
                  id="settlement-net"
                  inputMode="decimal"
                  value={form.netAmount}
                  onChange={(e) => setForm((f) => ({ ...f, netAmount: e.target.value }))}
                  placeholder="0"
                />
              </div>
            </div>

            <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-ink">Statement lines (optional)</span>
                <Button size="sm" variant="outline" onClick={addLine}>
                  <Plus className="h-4 w-4" />
                  Add line
                </Button>
              </div>
              <span className="text-xs text-ink-soft">
                Break the batch down line by line if the statement itemises it. A line whose provider
                transaction id matches a payment in this shop is linked to it; one that matches nothing
                is still recorded, which is how an unexplained payout gets noticed.
              </span>
              {lines.map((line) => (
                <div key={line.key} className="flex items-end gap-2">
                  <div className="flex flex-1 flex-col gap-1">
                    <label className="text-xs text-ink-soft">Amount</label>
                    <Input
                      inputMode="decimal"
                      value={line.amount}
                      onChange={(e) => updateLine(line.key, { amount: e.target.value })}
                      aria-label="Statement line amount"
                    />
                  </div>
                  <div className="flex flex-1 flex-col gap-1">
                    <label className="text-xs text-ink-soft">Provider transaction id</label>
                    <Input
                      value={line.providerTransactionId}
                      onChange={(e) => updateLine(line.key, { providerTransactionId: e.target.value })}
                      aria-label="Statement line provider transaction id"
                    />
                  </div>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Remove this statement line"
                    onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button disabled={!canSubmit} onClick={() => record.mutate()}>
              {record.isPending ? "Recording…" : "Record settlement"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageLayout>
  );
}
