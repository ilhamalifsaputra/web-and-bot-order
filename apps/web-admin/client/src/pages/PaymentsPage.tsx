import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { apiPost } from "../api/client";
import { formatCurrencyDisplay } from "../components/shared/CurrencyAmount";

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

  if (isError) return <PageLayout title="Payments"><p style={{ color: "red" }}>Failed to load payments.</p></PageLayout>;

  return (
    <PageLayout title="Payments">
      {/* Manual match form */}
      <section style={{ background: "#f9f9f9", padding: 16, borderRadius: 6, marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, marginBottom: 10 }}>Manual Match</h2>
        {matchError && <p style={{ color: "red", margin: "0 0 8px" }}>{matchError}</p>}
        <div style={{ display: "flex", gap: 8 }}>
          <input
            placeholder="Transfer ID"
            value={matchForm.binance_tx_id}
            onChange={e => setMatchForm(f => ({ ...f, binance_tx_id: e.target.value }))}
            style={{ flex: 1, padding: "5px 8px" }}
          />
          <input
            placeholder="Order code"
            value={matchForm.order_code}
            onChange={e => setMatchForm(f => ({ ...f, order_code: e.target.value }))}
            style={{ flex: 1, padding: "5px 8px" }}
          />
          <button onClick={() => match.mutate()} disabled={match.isPending} style={{ padding: "5px 14px" }}>
            Match
          </button>
        </div>
      </section>

      {/* Outcome filter */}
      <div style={{ marginBottom: 12, display: "flex", gap: 8, alignItems: "center" }}>
        <select value={outcome} onChange={e => { setOutcome(e.target.value); setPage(1); }} style={{ padding: "5px 8px" }}>
          <option value="">All outcomes</option>
          {(data?.outcomes ?? []).map(o => (
            <option key={o} value={o}>{o} ({data?.counts[o] ?? 0})</option>
          ))}
        </select>
        {data && <span style={{ color: "#666" }}>{data.total} transactions</span>}
      </div>

      {!data ? (
        <p>Loading…</p>
      ) : data.ledger.length === 0 ? (
        <p>No transactions found.</p>
      ) : (
        <>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#f5f5f5" }}>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>Transfer ID</th>
                <th style={{ textAlign: "right", padding: "6px 8px" }}>Amount</th>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>Outcome</th>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>Memo</th>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>Date</th>
                <th style={{ padding: "6px 8px" }} />
              </tr>
            </thead>
            <tbody>
              {data.ledger.map(tx => (
                <tr key={tx.id} style={{ borderTop: "1px solid #eee" }}>
                  <td style={{ padding: "6px 8px", fontFamily: "monospace", fontSize: 12 }}>{tx.binanceTxId}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right" }}>
                    {tx.amount && tx.currency ? formatCurrencyDisplay(tx.amount, tx.currency as "IDR" | "USDT" | "USD") : "—"}
                  </td>
                  <td style={{ padding: "6px 8px" }}>{tx.outcome}</td>
                  <td style={{ padding: "6px 8px", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tx.memo ?? "—"}</td>
                  <td style={{ padding: "6px 8px", fontSize: 12 }}>{new Date(tx.processedAt).toLocaleString()}</td>
                  <td style={{ padding: "6px 8px" }}>
                    {tx.outcome === "UNMATCHED" && (
                      <button
                        onClick={() => { if (confirm("Dismiss this transfer?")) dismiss.mutate(tx.binanceTxId); }}
                        style={{ fontSize: 12, color: "#888", background: "none", border: "1px solid #ccc", borderRadius: 3, cursor: "pointer", padding: "2px 8px" }}
                      >
                        Dismiss
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <button onClick={() => setPage(p => p - 1)} disabled={page === 1}>← Prev</button>
            <span>Page {page}</span>
            <button onClick={() => setPage(p => p + 1)} disabled={!data.hasNext}>Next →</button>
          </div>
        </>
      )}
    </PageLayout>
  );
}
