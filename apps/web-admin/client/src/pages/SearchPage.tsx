import { useSearchParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
      <PageHeader title="Search" />

      <form onSubmit={submit} className="flex gap-2 mb-6">
        <Input
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Order code, username, or product…"
          className="flex-1"
        />
        <Button type="submit">Search</Button>
      </form>

      {isError && <p className="text-sm text-rust">Failed to load results.</p>}
      {isFetching && <p className="text-sm text-ink-soft">Searching…</p>}

      {data && !isFetching && (
        <>
          {data.users.length === 0 && data.products.length === 0 && (
            <EmptyState title={`No results for "${data.q}"`} />
          )}

          {data.users.length > 0 && (
            <section className="mb-6">
              <h2 className="text-sm font-semibold text-ink mb-3">
                Customers ({data.users.length})
              </h2>
              <DataTable
                columns={[
                  {
                    key: "name",
                    header: "Name",
                    render: u => u.fullName ?? "—",
                  },
                  {
                    key: "username",
                    header: "Username",
                    render: u => u.username ? `@${u.username}` : "—",
                  },
                  {
                    key: "tid",
                    header: "Telegram ID",
                    render: u => <span className="font-mono text-xs">{u.telegramId}</span>,
                  },
                ]}
                data={data.users}
                keyExtractor={u => u.id}
                onRowClick={u => navigate(`/users/${u.id}`)}
              />
            </section>
          )}

          {data.products.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-ink mb-3">
                Products ({data.products.length})
              </h2>
              <DataTable
                columns={[
                  {
                    key: "denom",
                    header: "Denomination",
                    render: p => p.name,
                  },
                  {
                    key: "product",
                    header: "Product",
                    render: p => p.product?.name ?? "—",
                  },
                ]}
                data={data.products}
                keyExtractor={p => p.id}
                onRowClick={p => navigate(`/catalog/${p.id}`)}
              />
            </section>
          )}
        </>
      )}
    </PageLayout>
  );
}
