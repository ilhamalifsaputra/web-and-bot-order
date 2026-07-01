import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { FilterBar } from "../components/shared/FilterBar";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { formatCurrencyDisplay } from "../components/shared/CurrencyAmount";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { apiGet, apiPost } from "../api/client";

interface TxRow {
  id: number;
  binanceTxId: string;
  amount: string | null;
  currency: string | null;
  outcome: string;
  memo: string | null;
  processedAt: string;
}
interface PaymentsData {
  enabled: boolean;
  ledger: TxRow[];
  total: number;
  page: number;
  hasNext: boolean;
  outcomes: readonly string[];
  counts: Record<string, number>;
}

/** Shape of GET /api/search (apps/web-admin/src/routes/api/search.ts) — only
 * `q` and `exactOrderId` are used here; an order code either matches exactly
 * or the endpoint returns no order info at all (it has no partial/prefix
 * search over order codes). */
interface OrderCodeSearchResult {
  q: string;
  exactOrderId: number | null;
}

/** Outcomes a "pending"/"failed" stat card maps to — matches the lowercase
 * values written by packages/db/src/crud/binance_internal.ts (compared
 * case-insensitively since the field is a free-form string column). */
const PENDING_OUTCOMES = new Set(["unmatched"]);
const FAILED_OUTCOMES = new Set(["delivery_failed"]);

function isSameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function usePayments(outcome: string, page: number) {
  return useQuery<PaymentsData>({
    queryKey: ["payments", outcome, page],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page) });
      if (outcome) params.set("outcome", outcome);
      const res = await fetch(`/api/payments?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<PaymentsData>;
    },
  });
}

/** Debounce-calls GET /api/search as the admin types an order code and
 * reports whether that exact code currently matches an order. 300ms debounce
 * so we're not firing a request on every keystroke. */
function useOrderCodeSuggest(orderCode: string) {
  const [suggestion, setSuggestion] = useState<{ code: string } | null>(null);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const query = orderCode.trim();
    if (!query) {
      setSuggestion(null);
      setSearched(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      apiGet<OrderCodeSearchResult>(`/api/search?q=${encodeURIComponent(query)}`)
        .then(data => {
          if (cancelled) return;
          setSuggestion(data.exactOrderId ? { code: data.q.toUpperCase() } : null);
          setSearched(true);
        })
        .catch(() => { if (!cancelled) { setSuggestion(null); setSearched(true); } })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [orderCode]);

  return { suggestion, searched, loading };
}

export function PaymentsPage() {
  const qc = useQueryClient();
  const [outcome, setOutcome] = useState("");
  const [page, setPage] = useState(1);
  const [matchForm, setMatchForm] = useState({ binance_tx_id: "", order_code: "" });
  const [matchError, setMatchError] = useState<string | null>(null);
  const [orderCodeFocused, setOrderCodeFocused] = useState(false);
  const { data, isError } = usePayments(outcome, page);
  const { suggestion, searched, loading: suggestLoading } = useOrderCodeSuggest(matchForm.order_code);

  const stats = useMemo(() => {
    const ledger = data?.ledger ?? [];
    const today = new Date();
    let todayTotal = 0, pending = 0, failed = 0;
    for (const tx of ledger) {
      const outcomeLower = tx.outcome.toLowerCase();
      if (isSameLocalDay(new Date(tx.processedAt), today)) todayTotal += 1;
      if (PENDING_OUTCOMES.has(outcomeLower)) pending += 1;
      if (FAILED_OUTCOMES.has(outcomeLower)) failed += 1;
    }
    return { todayTotal, pending, failed };
  }, [data?.ledger]);

  const match = useMutation({
    mutationFn: () => apiPost("/api/payments/match", matchForm),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["payments"] });
      setMatchForm({ binance_tx_id: "", order_code: "" });
      setMatchError(null);
    },
    onError: (e: Error) => setMatchError(e.message),
  });

  const dismiss = useMutation({
    mutationFn: (txId: string) => apiPost("/api/payments/dismiss", { binance_tx_id: txId }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["payments"] }); },
    onError: (e: Error) => alert(e.message),
  });

  if (isError) return <PageLayout title="Payments"><p className="text-sm text-rust">Failed to load payments.</p></PageLayout>;

  const canSubmitMatch = matchForm.binance_tx_id.trim().length > 0 && matchForm.order_code.trim().length > 0;
  const showSuggestions = orderCodeFocused && matchForm.order_code.trim().length > 0 && (suggestLoading || searched);

  return (
    <PageLayout title="Payments">
      <PageHeader title="Payments" />

      {/* Summary stats — computed client-side from the already-fetched (current page of) transactions */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>Today&apos;s Transactions</CardTitle></CardHeader>
          <CardContent>
            <p className="font-display text-3xl font-semibold text-ink">{stats.todayTotal}</p>
            <p className="mt-1 text-xs text-ink-soft">Processed today, this page</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Pending</CardTitle></CardHeader>
          <CardContent>
            <p className="font-display text-3xl font-semibold text-ink">{stats.pending}</p>
            <p className="mt-1 text-xs text-ink-soft">Unmatched transfers</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Failed</CardTitle></CardHeader>
          <CardContent>
            <p className="font-display text-3xl font-semibold text-ink">{stats.failed}</p>
            <p className="mt-1 text-xs text-ink-soft">Delivery failures</p>
          </CardContent>
        </Card>
      </div>

      {/* Manual match form */}
      <Card className="mb-6">
        <CardHeader><CardTitle>Manual Match</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          {matchError && <p className="text-sm text-rust">{matchError}</p>}
          <div className="flex flex-wrap items-start gap-2">
            <Input
              placeholder="Transfer ID"
              value={matchForm.binance_tx_id}
              onChange={e => setMatchForm(f => ({ ...f, binance_tx_id: e.target.value }))}
              className="w-48"
            />
            <div className="relative w-40">
              <Input
                placeholder="Order code"
                value={matchForm.order_code}
                onChange={e => setMatchForm(f => ({ ...f, order_code: e.target.value }))}
                onFocus={() => setOrderCodeFocused(true)}
                onBlur={() => setTimeout(() => setOrderCodeFocused(false), 150)}
                autoComplete="off"
              />
              {showSuggestions && (
                <div className="absolute left-0 right-0 top-full z-10 mt-1 rounded-md border border-line bg-card shadow-lift">
                  {suggestLoading && (
                    <div className="px-3 py-2 text-xs text-ink-faint">Searching…</div>
                  )}
                  {!suggestLoading && suggestion && (
                    <button
                      type="button"
                      className="block w-full px-3 py-2 text-left text-sm hover:bg-sand"
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => {
                        setMatchForm(f => ({ ...f, order_code: suggestion.code }));
                        setOrderCodeFocused(false);
                      }}
                    >
                      <span className="font-mono">{suggestion.code}</span>
                      <span className="ml-2 text-xs text-ink-soft">order found</span>
                    </button>
                  )}
                  {!suggestLoading && !suggestion && (
                    <div className="px-3 py-2 text-xs text-ink-faint">No matching order code</div>
                  )}
                </div>
              )}
            </div>
            <ConfirmDialog
              trigger={<Button variant="outline" disabled={match.isPending || !canSubmitMatch}>Match</Button>}
              title="Confirm manual match?"
              description={`Match transfer ${matchForm.binance_tx_id} to order ${matchForm.order_code}.`}
              confirmLabel="Match"
              variant="default"
              onConfirm={() => match.mutate()}
            />
          </div>
        </CardContent>
      </Card>

      {/* Outcome filter */}
      <FilterBar className="mb-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Outcome</label>
          <Select
            value={outcome || "_all_"}
            onValueChange={v => { setOutcome(v === "_all_" ? "" : v); setPage(1); }}
          >
            <SelectTrigger className="w-40"><SelectValue placeholder="All outcomes" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="_all_">All</SelectItem>
              {(data?.outcomes ?? []).map(o => (
                <SelectItem key={o} value={o}>{o} ({data?.counts[o] ?? 0})</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {data && <span className="text-sm text-ink-soft self-end">{data.total} transactions</span>}
      </FilterBar>

      <DataTable
        columns={[
          {
            key: "txid",
            header: "Transfer ID",
            render: tx => <span className="font-mono text-xs">{tx.binanceTxId}</span>,
          },
          {
            key: "amount",
            header: "Amount",
            render: tx => (
              <span className="font-mono text-sm">
                {tx.amount && tx.currency
                  ? formatCurrencyDisplay(tx.amount, tx.currency as "IDR" | "USDT" | "USD")
                  : "—"}
              </span>
            ),
          },
          {
            key: "outcome",
            header: "Outcome",
            render: tx => <Badge variant="outline">{tx.outcome}</Badge>,
          },
          {
            key: "memo",
            header: "Memo",
            render: tx => (
              <span className="text-xs text-ink-soft truncate max-w-[200px] block">{tx.memo ?? "—"}</span>
            ),
          },
          {
            key: "date",
            header: "Date",
            render: tx => (
              <span className="text-xs text-ink-soft whitespace-nowrap">
                {new Date(tx.processedAt).toLocaleString()}
              </span>
            ),
          },
          {
            key: "actions",
            header: "",
            render: tx => tx.outcome === "UNMATCHED" ? (
              <ConfirmDialog
                trigger={<Button variant="ghost" size="sm">Dismiss</Button>}
                title="Dismiss transfer?"
                description={`Mark transfer ${tx.binanceTxId} as dismissed.`}
                confirmLabel="Dismiss"
                onConfirm={() => dismiss.mutate(tx.binanceTxId)}
              />
            ) : null,
          },
        ]}
        data={data?.ledger ?? []}
        isLoading={!data}
        keyExtractor={tx => tx.id}
        empty={<EmptyState title="No transactions found" description="Try a different outcome filter." />}
      />

      {data && (data.hasNext || page > 1) && (
        <div className="mt-4 flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setPage(p => p - 1)} disabled={page === 1}>
            ← Prev
          </Button>
          <span className="text-sm text-ink-soft">Page {page}</span>
          <Button variant="outline" size="sm" onClick={() => setPage(p => p + 1)} disabled={!data.hasNext}>
            Next →
          </Button>
        </div>
      )}
    </PageLayout>
  );
}
