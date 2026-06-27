import { useSearchParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { PageLayout } from "../components/shared/PageLayout";

interface UserHit {
  id: number;
  username: string | null;
  fullName: string | null;
  telegramId: string;
}
interface ProductHit {
  id: number;
  name: string;
  product?: { name: string } | null;
}
interface SearchResult {
  q: string;
  exactOrderId: number | null;
  users: UserHit[];
  products: ProductHit[];
}

function useSearch(q: string) {
  return useQuery<SearchResult>({
    queryKey: ["search", q],
    queryFn: async () => {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<SearchResult>;
    },
    enabled: q.length > 0,
  });
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const q = params.get("q") ?? "";
  const [input, setInput] = useState(q);
  const { data, isError, isFetching } = useSearch(q);

  useEffect(() => { setInput(q); }, [q]);

  useEffect(() => {
    if (data?.exactOrderId) {
      navigate(`/orders/${data.exactOrderId}`);
    }
  }, [data?.exactOrderId, navigate]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (input.trim()) setParams({ q: input.trim() });
  }

  return (
    <PageLayout title="Search">
      <form onSubmit={submit} style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Order code, username, or product…"
          style={{ flex: 1, padding: "6px 10px", border: "1px solid #ccc", borderRadius: 4 }}
        />
        <button type="submit" style={{ padding: "6px 16px" }}>Search</button>
      </form>

      {isError && <p style={{ color: "red" }}>Failed to load results.</p>}
      {isFetching && <p>Searching…</p>}

      {data && !isFetching && (
        <>
          {data.users.length === 0 && data.products.length === 0 && (
            <p>No results for "{data.q}".</p>
          )}
          {data.users.length > 0 && (
            <section style={{ marginBottom: 24 }}>
              <h2 style={{ fontSize: 16, marginBottom: 8 }}>Customers ({data.users.length})</h2>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "#f5f5f5" }}>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Name</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Username</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Telegram ID</th>
                  </tr>
                </thead>
                <tbody>
                  {data.users.map(u => (
                    <tr
                      key={u.id}
                      style={{ borderTop: "1px solid #eee", cursor: "pointer" }}
                      onClick={() => navigate(`/users/${u.id}`)}
                    >
                      <td style={{ padding: "6px 8px" }}>{u.fullName ?? "—"}</td>
                      <td style={{ padding: "6px 8px" }}>{u.username ? `@${u.username}` : "—"}</td>
                      <td style={{ padding: "6px 8px" }}>{u.telegramId}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {data.products.length > 0 && (
            <section>
              <h2 style={{ fontSize: 16, marginBottom: 8 }}>Products ({data.products.length})</h2>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "#f5f5f5" }}>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Denomination</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Product</th>
                  </tr>
                </thead>
                <tbody>
                  {data.products.map(p => (
                    <tr
                      key={p.id}
                      style={{ borderTop: "1px solid #eee", cursor: "pointer" }}
                      onClick={() => navigate(`/catalog/${p.id}`)}
                    >
                      <td style={{ padding: "6px 8px" }}>{p.name}</td>
                      <td style={{ padding: "6px 8px" }}>{p.product?.name ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </PageLayout>
  );
}
