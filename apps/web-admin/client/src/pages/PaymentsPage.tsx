import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { FilterBar } from "../components/shared/FilterBar";
import { SearchBar } from "../components/shared/SearchBar";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { StatusBadge } from "../components/shared/StatusBadge";
import { StatCard } from "../components/shared/StatCard";
import { UrgencyDot } from "../components/shared/UrgencyDot";
import { Pagination } from "../components/shared/Pagination";
import { formatCurrencyDisplay } from "../components/shared/CurrencyAmount";
import { CreditCard, PackageCheck, Undo2, X, MoreVertical, Clock, Hourglass, XCircle, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { apiGet, apiPost } from "../api/client";
import { describeError } from "../lib/errorMessages";

interface TxRow {
  id: number;
  binanceTxId: string;
  amount: string | null;
  currency: string | null;
  outcome: string;
  memo: string | null;
  processedAt: string;
  processedAtDisplay: string | null;
}
interface OrderPartyRow {
  fullName: string | null;
  username: string | null;
}
interface UnderpaidOrderRow {
  id: number;
  orderCode: string;
  totalAmount: string;
  currency: string;
  createdAt: string;
  createdAtDisplay: string | null;
  user: OrderPartyRow | null;
}
interface PendingInternalOrderRow {
  id: number;
  orderCode: string;
  totalAmount: string;
  currency: string;
  paymentRef: string | null;
  expiresAt: string | null;
  expiresAtDisplay: string | null;
  user: OrderPartyRow | null;
}
interface PaymentsHealth {
  lastRun: string | null;
  lastSuccessAt: string | null;
  lastTxCount: number | null;
  backoffUntil: string | null;
  consecutiveRateLimitHits: number | null;
  lastRateLimitAt: string | null;
  consecutiveFailures: number | null;
  lastError: string | null;
}
interface PaymentsData {
  enabled: boolean;
  ledger: TxRow[];
  total: number;
  todayCount: number;
  page: number;
  hasNext: boolean;
  outcomes: readonly string[];
  counts: Record<string, number>;
  health: PaymentsHealth;
  underpaid: UnderpaidOrderRow[];
  pendingInternal: PendingInternalOrderRow[];
}

/** Shape of GET /api/search (apps/web-admin/src/routes/api/search.ts) — only
 * `q` and `exactOrderId` are used here; an order code either matches exactly
 * or the endpoint returns no order info at all (it has no partial/prefix
 * search over order codes). */
interface OrderCodeSearchResult {
  q: string;
  exactOrderId: number | null;
}

function usePayments(outcome: string, q: string, page: number) {
  return useQuery<PaymentsData>({
    queryKey: ["payments", outcome, q, page],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page) });
      if (outcome) params.set("outcome", outcome);
      if (q) params.set("q", q);
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

function relativeTime(iso: string): string {
  const ms = new Date(iso).getTime();
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function healthPill(health: PaymentsHealth): { level: "ok" | "warn" | "critical" | "idle"; text: string } {
  if ((health.consecutiveFailures ?? 0) > 0) {
    return { level: "critical", text: `${health.consecutiveFailures} consecutive failures` };
  }
  if (health.backoffUntil && new Date(health.backoffUntil).getTime() > Date.now()) {
    return { level: "warn", text: `Rate-limited, retrying at ${new Date(health.backoffUntil).toLocaleTimeString()}` };
  }
  if (!health.lastRun) {
    return { level: "idle", text: "Not yet synced" };
  }
  return { level: "ok", text: `Synced ${relativeTime(health.lastRun)}` };
}

export function PaymentsPage() {
  const qc = useQueryClient();
  const [outcome, setOutcome] = useState("");
  const [page, setPage] = useState(1);
  const [qDraft, setQDraft] = useState("");
  const [q, setQ] = useState("");
  const [matchForm, setMatchForm] = useState({ binance_tx_id: "", order_code: "" });
  const [matchError, setMatchError] = useState<string | null>(null);
  const [orderCodeFocused, setOrderCodeFocused] = useState(false);
  const [pendingDeliver, setPendingDeliver] = useState<UnderpaidOrderRow | null>(null);
  const [pendingRefund, setPendingRefund] = useState<UnderpaidOrderRow | null>(null);
  const [pendingCancel, setPendingCancel] = useState<UnderpaidOrderRow | null>(null);
  const [pendingDismiss, setPendingDismiss] = useState<TxRow | null>(null);
  const [pendingCredit, setPendingCredit] = useState<TxRow | null>(null);
  const [creditOrderCode, setCreditOrderCode] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  useEffect(() => {
    const timer = setTimeout(() => { setQ(qDraft); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [qDraft]);
  useEffect(() => { setSelected(new Set()); }, [outcome, q, page]);
  const { data, isError } = usePayments(outcome, q, page);
  const { suggestion, searched, loading: suggestLoading } = useOrderCodeSuggest(matchForm.order_code);
  const { suggestion: creditSuggestion, loading: creditSuggestLoading } = useOrderCodeSuggest(creditOrderCode);
  const underpaid = data?.underpaid ?? [];
  const pendingInternal = data?.pendingInternal ?? [];

  const match = useMutation({
    mutationFn: () => apiPost("/api/payments/match", matchForm),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["payments"] });
      setMatchForm({ binance_tx_id: "", order_code: "" });
      setMatchError(null);
    },
    onError: (e: Error) => setMatchError(describeError(e.message)),
  });

  const dismiss = useMutation({
    mutationFn: (txId: string) => apiPost("/api/payments/dismiss", { binance_tx_id: txId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["payments"] });
      toast.success("Transfer dismissed.");
      setPendingDismiss(null);
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const creditToBalance = useMutation({
    mutationFn: () => apiPost("/api/payments/credit", { binance_tx_id: pendingCredit!.binanceTxId, order_code: creditOrderCode.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["payments"] });
      toast.success("Added to the buyer's credit balance.");
      setPendingCredit(null);
      setCreditOrderCode("");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const deliverAnyway = useMutation({
    mutationFn: (orderId: number) => apiPost(`/api/payments/order/${orderId}/deliver`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["payments"] });
      toast.success("Order delivered.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const refundUnderpaid = useMutation({
    mutationFn: (orderId: number) => apiPost(`/api/payments/order/${orderId}/refund`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["payments"] });
      toast.success("Order refunded to wallet.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const cancelUnderpaid = useMutation({
    mutationFn: (orderId: number) => apiPost(`/api/payments/order/${orderId}/cancel`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["payments"] });
      toast.success("Order cancelled.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const ledgerRows = data?.ledger ?? [];
  const eligibleRows = ledgerRows.filter(tx => tx.outcome === "unmatched");
  const allEligibleSelected = eligibleRows.length > 0 && eligibleRows.every(tx => selected.has(tx.id));

  function toggleSelected(id: number) {
    setSelected(s => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }
  function toggleSelectAllEligible() {
    setSelected(prev => {
      const next = new Set(prev);
      if (allEligibleSelected) {
        eligibleRows.forEach(tx => next.delete(tx.id));
      } else {
        eligibleRows.forEach(tx => next.add(tx.id));
      }
      return next;
    });
  }

  const bulkDismiss = useMutation({
    mutationFn: async (ids: number[]) => {
      const rows = ledgerRows.filter(tx => ids.includes(tx.id));
      const results = await Promise.allSettled(rows.map(tx => apiPost("/api/payments/dismiss", { binance_tx_id: tx.binanceTxId })));
      const failed = results.filter(r => r.status === "rejected").length;
      return { succeeded: results.length - failed, failed };
    },
    onSuccess: ({ succeeded, failed }) => {
      void qc.invalidateQueries({ queryKey: ["payments"] });
      setSelected(new Set());
      toast.success(failed > 0 ? `Dismissed ${succeeded} of ${succeeded + failed} transfers — ${failed} failed.` : `Dismissed ${succeeded} transfer${succeeded === 1 ? "" : "s"}.`);
    },
  });

  if (isError) return <PageLayout title="Payments"><p className="text-sm text-rust">Failed to load payments.</p></PageLayout>;

  const canSubmitMatch = matchForm.binance_tx_id.trim().length > 0 && matchForm.order_code.trim().length > 0;
  const showSuggestions = orderCodeFocused && matchForm.order_code.trim().length > 0 && (suggestLoading || searched);

  return (
    <PageLayout title="Payments">
      <PageHeader title="Payments" description="Match transfers to orders and resolve payment issues." />

      {data?.enabled && data?.health && (() => {
        const pill = healthPill(data.health);
        return (
          <div className="mb-4 flex items-center gap-2 text-xs text-ink-soft">
            <UrgencyDot level={pill.level} />
            {pill.text}
          </div>
        );
      })()}

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="Today's Transactions"
          value={data?.todayCount ?? 0}
          icon={Clock}
          isLoading={!data}
        />
        <StatCard
          label="Pending"
          value={data?.counts["unmatched"] ?? 0}
          icon={Hourglass}
          tone="warning"
          isLoading={!data}
        />
        <StatCard
          label="Failed"
          value={data?.counts["delivery_failed"] ?? 0}
          icon={XCircle}
          tone="danger"
          isLoading={!data}
        />
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

      {underpaid.length > 0 && (
        <Card className="mb-6">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-1.5 text-sm font-semibold text-ink-soft">
              Underpaid Orders
              <span className="rounded-full bg-amberx-tint px-1.5 py-0.5 text-xs font-semibold text-amberx">{underpaid.length}</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
          <DataTable
            columns={[
              {
                key: "order",
                header: "Order",
                render: o => (
                  <div className="flex flex-col">
                    <span className="font-mono text-xs">{o.orderCode}</span>
                    <span className="text-xs text-ink-soft">{o.user?.fullName ?? o.user?.username ?? "Unknown"}</span>
                  </div>
                ),
              },
              {
                key: "amount",
                header: "Amount",
                render: o => <span className="font-mono text-sm">{formatCurrencyDisplay(o.totalAmount, o.currency as "IDR" | "USDT" | "USD")}</span>,
              },
              {
                key: "date",
                header: "Date",
                render: o => <span className="text-xs text-ink-soft whitespace-nowrap">{o.createdAtDisplay ?? "—"}</span>,
              },
              {
                key: "actions",
                header: "",
                render: o => (
                  <div onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`Actions for order ${o.orderCode}`}>
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setPendingDeliver(o); }}>
                          <PackageCheck className="h-4 w-4" />
                          Deliver anyway
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setPendingRefund(o); }}>
                          <Undo2 className="h-4 w-4" />
                          Refund
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onSelect={(e) => { e.preventDefault(); setPendingCancel(o); }}>
                          <X className="h-4 w-4" />
                          Cancel order
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ),
              },
            ]}
            data={underpaid}
            keyExtractor={o => o.id}
            empty={<EmptyState title="No underpaid orders" description="Orders will show here if a payment falls short of the total." />}
          />
          </CardContent>
        </Card>
      )}

      {pendingInternal.length > 0 && (
        <Card className="mb-6">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-1.5 text-sm font-semibold text-ink-soft">
              Pending Internal Transfers
              <span className="rounded-full bg-sand px-1.5 py-0.5 text-xs font-semibold text-ink-soft">{pendingInternal.length}</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
          <DataTable
            columns={[
              { key: "order", header: "Order", render: o => <span className="font-mono text-xs">{o.orderCode}</span> },
              { key: "user", header: "Buyer", render: o => <span className="text-xs text-ink-soft">{o.user?.fullName ?? o.user?.username ?? "Unknown"}</span> },
              { key: "amount", header: "Amount", render: o => <span className="font-mono text-sm">{formatCurrencyDisplay(o.totalAmount, o.currency as "IDR" | "USDT" | "USD")}</span> },
              { key: "ref", header: "Transfer Ref", render: o => <span className="font-mono text-xs">{o.paymentRef ?? "—"}</span> },
              { key: "expires", header: "Expires", render: o => <span className="text-xs text-ink-soft whitespace-nowrap">{o.expiresAtDisplay ?? "—"}</span> },
            ]}
            data={pendingInternal}
            keyExtractor={o => o.id}
            empty={<EmptyState title="No pending internal transfers" description="Internal transfers awaiting confirmation will appear here." />}
          />
          </CardContent>
        </Card>
      )}

      {/* Ledger search + outcome filter */}
      <FilterBar className="mb-4">
        <SearchBar
          value={qDraft}
          onChange={setQDraft}
          placeholder="Search Transfer ID..."
          className="w-full sm:w-64"
        />
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

      {selected.size > 0 && (
        <div className="sticky bottom-4 z-10 mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-card px-3 py-2 text-sm shadow-lift transition-all duration-150">
          <span className="text-ink-soft">{selected.size} selected</span>
          <Button
            size="sm"
            variant="destructive"
            disabled={bulkDismiss.isPending}
            onClick={() => bulkDismiss.mutate(Array.from(selected))}
          >
            Dismiss {selected.size} transfer{selected.size === 1 ? "" : "s"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}

      <DataTable
        columns={[
          {
            key: "select",
            header: (
              <Checkbox
                checked={allEligibleSelected}
                onCheckedChange={toggleSelectAllEligible}
                disabled={eligibleRows.length === 0}
                aria-label="Select all eligible transfers"
              />
            ),
            render: tx => tx.outcome === "unmatched" ? (
              <Checkbox
                checked={selected.has(tx.id)}
                onCheckedChange={() => toggleSelected(tx.id)}
                onClick={e => e.stopPropagation()}
                aria-label={`Select transfer ${tx.binanceTxId}`}
              />
            ) : null,
          },
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
            render: tx => <StatusBadge status={tx.outcome.toUpperCase()} />,
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
                {tx.processedAtDisplay ?? "—"}
              </span>
            ),
          },
          {
            key: "actions",
            header: "",
            render: tx => tx.outcome === "unmatched" ? (
              <div onClick={(e) => e.stopPropagation()}>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`Actions for transfer ${tx.binanceTxId}`}>
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setPendingCredit(tx); setCreditOrderCode(""); }}>
                      <Wallet className="h-4 w-4" />
                      Add to buyer&apos;s credit balance
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setPendingDismiss(tx); }}>
                      <X className="h-4 w-4" />
                      Dismiss
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ) : null,
          },
        ]}
        data={data?.ledger ?? []}
        isLoading={!data}
        keyExtractor={tx => tx.id}
        empty={
          <EmptyState
            icon={CreditCard}
            title="No transactions found"
            description={outcome ? "Try a different outcome filter." : "Transactions will appear here once payments are processed."}
            secondaryAction={outcome ? { label: "Clear Filters", onClick: () => { setOutcome(""); setPage(1); } } : undefined}
          />
        }
      />

      {data && (
        <div className="mt-4">
          <Pagination
            page={page}
            pageSize={50}
            total={data.total}
            onPageChange={setPage}
          />
        </div>
      )}

      {pendingDeliver && (
        <ConfirmDialog
          open
          onOpenChange={(open) => { if (!open) setPendingDeliver(null); }}
          title="Deliver this order anyway?"
          description={`Order ${pendingDeliver.orderCode} was underpaid. Deliver it anyway — this writes off the shortfall.`}
          confirmLabel="Deliver anyway"
          variant="default"
          onConfirm={() => deliverAnyway.mutate(pendingDeliver.id)}
        />
      )}
      {pendingRefund && (
        <ConfirmDialog
          open
          onOpenChange={(open) => { if (!open) setPendingRefund(null); }}
          title="Refund to the buyer's wallet?"
          description={`Refund order ${pendingRefund.orderCode}'s payment to the buyer's wallet balance.`}
          confirmLabel="Refund"
          variant="default"
          onConfirm={() => refundUnderpaid.mutate(pendingRefund.id)}
        />
      )}
      {pendingCancel && (
        <ConfirmDialog
          open
          onOpenChange={(open) => { if (!open) setPendingCancel(null); }}
          title="Cancel this order?"
          description={`Cancel order ${pendingCancel.orderCode}. Any reserved stock or wallet holds are released.`}
          confirmLabel="Cancel order"
          onConfirm={() => cancelUnderpaid.mutate(pendingCancel.id)}
        />
      )}
      {pendingDismiss && (
        <ConfirmDialog
          open
          onOpenChange={(open) => { if (!open) setPendingDismiss(null); }}
          title="Dismiss transfer?"
          description={`Mark transfer ${pendingDismiss.binanceTxId} as dismissed.`}
          confirmLabel="Dismiss"
          onConfirm={() => dismiss.mutate(pendingDismiss.binanceTxId)}
        />
      )}
      {pendingCredit && (
        <Dialog open onOpenChange={(open) => { if (!open) { setPendingCredit(null); setCreditOrderCode(""); } }}>
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>Add to buyer&apos;s credit balance</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <p className="text-sm text-ink-soft">
                Adds transfer {pendingCredit.binanceTxId}&apos;s amount to the matching order&apos;s buyer credit balance and cancels the order. Enter the order code this transfer belongs to.
              </p>
              <Input
                placeholder="Order code"
                value={creditOrderCode}
                onChange={e => setCreditOrderCode(e.target.value)}
                autoComplete="off"
              />
              {creditSuggestLoading && <p className="text-xs text-ink-faint">Searching…</p>}
              {!creditSuggestLoading && creditOrderCode.trim() && !creditSuggestion && (
                <p className="text-xs text-ink-faint">No matching order code</p>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setPendingCredit(null); setCreditOrderCode(""); }}>Back</Button>
              <Button
                disabled={!creditSuggestion || creditToBalance.isPending}
                onClick={() => creditToBalance.mutate()}
              >
                Add to credit balance
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </PageLayout>
  );
}
