import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { PageLayout } from "../components/shared/PageLayout";

interface DenominationRow {
  id: number;
  name: string;
  isActive: boolean;
  product: {
    id: number;
    name: string;
    category: { name: string } | null;
  } | null;
}

interface StockData {
  denominations: DenominationRow[];
  counts: Record<string, { available: number; reserved: number; sold: number; dead: number }>;
  waiting: Record<string, number>;
}

function useStock() {
  return useQuery<StockData>({
    queryKey: ["stock"],
    queryFn: async () => {
      const res = await fetch("/api/stock");
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<StockData>;
    },
  });
}

export function StockPage() {
  const navigate = useNavigate();
  const { data, isError } = useStock();
  const [filter, setFilter] = useState("");

  if (isError) {
    return (
      <PageLayout title="Stock">
        <p style={{ color: "red" }}>Failed to load stock.</p>
      </PageLayout>
    );
  }

  const filtered = (data?.denominations ?? []).filter(
    (d) =>
      !filter ||
      d.name.toLowerCase().includes(filter.toLowerCase()) ||
      (d.product?.name ?? "").toLowerCase().includes(filter.toLowerCase()) ||
      (d.product?.category?.name ?? "").toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <PageLayout title="Stock">
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by denomination, product, or category…"
          style={{ flex: 1, padding: "6px 10px", border: "1px solid #ccc", borderRadius: 4 }}
        />
        {filter && (
          <button type="button" onClick={() => setFilter("")} style={{ padding: "6px 12px" }}>
            Clear
          </button>
        )}
      </div>

      {!data ? (
        <p>Loading…</p>
      ) : filtered.length === 0 ? (
        <p>No denominations found.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#f5f5f5" }}>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>Denomination</th>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>Product</th>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>Category</th>
              <th style={{ textAlign: "center", padding: "6px 8px" }}>Available</th>
              <th style={{ textAlign: "center", padding: "6px 8px" }}>Sold</th>
              <th style={{ textAlign: "center", padding: "6px 8px" }}>Waiting</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((d) => {
              const cnt = data.counts[String(d.id)];
              const wait = data.waiting[String(d.id)] ?? 0;
              return (
                <tr
                  key={d.id}
                  style={{ borderTop: "1px solid #eee", cursor: "pointer" }}
                  onClick={() => navigate(`/stock/${d.id}`)}
                >
                  <td style={{ padding: "6px 8px" }}>{d.name}</td>
                  <td style={{ padding: "6px 8px" }}>{d.product?.name ?? "—"}</td>
                  <td style={{ padding: "6px 8px" }}>{d.product?.category?.name ?? "—"}</td>
                  <td
                    style={{
                      padding: "6px 8px",
                      textAlign: "center",
                      color: (cnt?.available ?? 0) === 0 ? "#c00" : undefined,
                    }}
                  >
                    {cnt?.available ?? 0}
                  </td>
                  <td style={{ padding: "6px 8px", textAlign: "center" }}>
                    {cnt?.sold ?? 0}
                  </td>
                  <td style={{ padding: "6px 8px", textAlign: "center" }}>
                    {wait > 0 ? wait : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </PageLayout>
  );
}
