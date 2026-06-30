import { useState } from "react";
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
import { apiPost } from "../api/client";

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

export function PaymentsPage() {
  const qc = useQueryClient();
  const [outcome, setOutcome] = useState("");
  const [page, setPage] = useState(1);
  const [matchForm, setMatchForm] = useState({ binance_tx_id: "", order_code: "" });
  const [matchError, setMatchError] = useState<string | null>(null);
  const { data, isError } = usePayments(outcome, page);

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

  return (
    <PageLayout title="Payments">
      <PageHeader title="Payments" />

      {/* Manual match form */}
      <Card className="mb-6">
        <CardHeader><CardTitle>Manual Match</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          {matchError && <p className="text-sm text-rust">{matchError}</p>}
          <div className="flex flex-wrap gap-2">
            <Input
              placeholder="Transfer ID"
              value={matchForm.binance_tx_id}
              onChange={e => setMatchForm(f => ({ ...f, binance_tx_id: e.target.value }))}
              className="w-48"
            />
            <Input
              placeholder="Order code"
              value={matchForm.order_code}
              onChange={e => setMatchForm(f => ({ ...f, order_code: e.target.value }))}
              className="w-40"
            />
            <Button variant="outline" onClick={() => match.mutate()} disabled={match.isPending}>Match</Button>
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
