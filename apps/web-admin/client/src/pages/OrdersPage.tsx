import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { PageLayout } from "../components/shared/PageLayout";

interface OrderRow {
  id: number;
  orderCode: string;
  status: string;
  currency: string;
  totalAmount: string;
  createdAt: string;
  user: { id: number; fullName: string | null; username: string | null } | null;
}

interface OrdersData {
  orders: OrderRow[];
  total: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
  statuses: string[];
}

interface Filters {
  status: string;
  q: string;
  since: string;
  until: string;
  page: number;
}

function useOrders(filters: Filters) {
  return useQuery<OrdersData>({
    queryKey: ["orders", filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.status) params.set("status", filters.status);
      if (filters.q) params.set("q", filters.q);
      if (filters.since) params.set("since", filters.since);
      if (filters.until) params.set("until", filters.until);
      if (filters.page > 1) params.set("page", String(filters.page));
      const res = await fetch(`/api/orders?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<OrdersData>;
    },
  });
}

export function OrdersPage() {
  const navigate = useNavigate();
  const [draft, setDraft] = useState({ status: "", q: "", since: "", until: "" });
  const [filters, setFilters] = useState<Filters>({ status: "", q: "", since: "", until: "", page: 1 });

  const { data, isError } = useOrders(filters);

  if (isError) {
    return (
      <PageLayout title="Orders">
        <p style={{ color: "red" }}>Failed to load orders.</p>
      </PageLayout>
    );
  }

  const statuses = data?.statuses ?? [];

  function applyFilters() {
    setFilters({ ...draft, page: 1 });
  }

  function clearFilters() {
    setDraft({ status: "", q: "", since: "", until: "" });
    setFilters({ status: "", q: "", since: "", until: "", page: 1 });
  }

  return (
    <PageLayout title="Orders">
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <select
          value={draft.status}
          onChange={(e) => setDraft((f) => ({ ...f, status: e.target.value }))}
          style={{ padding: "6px 8px" }}
        >
          <option value="">All statuses</option>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input
          value={draft.q}
          onChange={(e) => setDraft((f) => ({ ...f, q: e.target.value }))}
          placeholder="Order code…"
          style={{ padding: "6px 10px", border: "1px solid #ccc", borderRadius: 4, width: 160 }}
        />
        <input
          type="date"
          value={draft.since}
          onChange={(e) => setDraft((f) => ({ ...f, since: e.target.value }))}
          style={{ padding: "6px 8px" }}
        />
        <input
          type="date"
          value={draft.until}
          onChange={(e) => setDraft((f) => ({ ...f, until: e.target.value }))}
          style={{ padding: "6px 8px" }}
        />
        <button type="button" onClick={applyFilters} style={{ padding: "6px 16px" }}>
          Filter
        </button>
        <button type="button" onClick={clearFilters} style={{ padding: "6px 12px" }}>
          Clear
        </button>
      </div>

      {!data ? (
        <p>Loading…</p>
      ) : data.orders.length === 0 ? (
        <p>No orders found.</p>
      ) : (
        <>
          <p style={{ color: "#666", fontSize: 13, marginBottom: 8 }}>
            {data.total} order{data.total !== 1 ? "s" : ""} total — page {data.page}
          </p>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#f5f5f5" }}>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>Code</th>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>Customer</th>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>Status</th>
                <th style={{ textAlign: "right", padding: "6px 8px" }}>Total</th>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>Date</th>
              </tr>
            </thead>
            <tbody>
              {data.orders.map((o) => (
                <tr
                  key={o.id}
                  style={{ borderTop: "1px solid #eee", cursor: "pointer" }}
                  onClick={() => navigate(`/orders/${o.id}`)}
                >
                  <td style={{ padding: "6px 8px", fontFamily: "monospace" }}>{o.orderCode}</td>
                  <td style={{ padding: "6px 8px" }}>
                    {o.user?.fullName ?? o.user?.username ?? "—"}
                  </td>
                  <td style={{ padding: "6px 8px" }}>{o.status}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right" }}>
                    {o.totalAmount} {o.currency}
                  </td>
                  <td style={{ padding: "6px 8px", fontSize: 12 }}>
                    {new Date(o.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            {data.page > 1 && (
              <button
                type="button"
                onClick={() => setFilters((f) => ({ ...f, page: f.page - 1 }))}
                style={{ padding: "5px 12px" }}
              >
                ← Prev
              </button>
            )}
            {data.hasNext && (
              <button
                type="button"
                onClick={() => setFilters((f) => ({ ...f, page: f.page + 1 }))}
                style={{ padding: "5px 12px" }}
              >
                Next →
              </button>
            )}
          </div>
        </>
      )}
    </PageLayout>
  );
}
