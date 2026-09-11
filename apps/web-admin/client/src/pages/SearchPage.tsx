import { useSearchParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Users, PackageSearch, SearchX } from "lucide-react";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { FilterBar } from "../components/shared/FilterBar";
import { SearchBar } from "../components/shared/SearchBar";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { apiGet } from "../api/client";

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
    queryFn: () => apiGet<SearchResult>(`/api/search?q=${encodeURIComponent(q)}`),
    enabled: q.length > 0,
  });
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const q = params.get("q") ?? "";
  const [draft, setDraft] = useState(q);
  const { data, isError, isFetching } = useSearch(q);

  useEffect(() => { setDraft(q); }, [q]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const trimmed = draft.trim();
      if (trimmed) setParams({ q: trimmed });
      else setParams({});
    }, 300);
    return () => clearTimeout(timer);
  }, [draft]);

  useEffect(() => {
    if (data?.exactOrderId) {
      navigate(`/orders/${data.exactOrderId}`);
    }
  }, [data?.exactOrderId, navigate]);

  return (
    <PageLayout title="Search">
      <PageHeader title="Search" />

      <FilterBar className="mb-6">
        <SearchBar
          value={draft}
          onChange={setDraft}
          placeholder="Order code, username, or product…"
          className="w-full sm:w-96"
        />
      </FilterBar>

      {isError && <p className="text-sm text-rust">Failed to load results.</p>}
      {isFetching && <p className="text-sm text-ink-soft">Searching…</p>}

      {data && !isFetching && (
        <>
          {data.users.length === 0 && data.products.length === 0 ? (
            <EmptyState
              icon={SearchX}
              title={`No results for "${data.q}"`}
              description="Try an order code, username, or product name."
            />
          ) : (
            <>
              <section className="mb-6">
                <Card>
                  <CardHeader>
                    <CardTitle as="h2">Customers ({data.users.length})</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <DataTable
                      nested
                      columns={[
                        {
                          key: "name",
                          header: "Name",
                          render: u => (
                            <span className="block max-w-[240px] truncate" title={u.fullName ?? undefined}>
                              {u.fullName ?? "—"}
                            </span>
                          ),
                        },
                        {
                          key: "username",
                          header: "Username",
                          render: u => (
                            <span className="block max-w-[200px] truncate" title={u.username ? `@${u.username}` : undefined}>
                              {u.username ? `@${u.username}` : "—"}
                            </span>
                          ),
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
                      empty={<EmptyState icon={Users} title="No matching customers." description="Try a different search term." />}
                    />
                  </CardContent>
                </Card>
              </section>

              <section>
                <Card>
                  <CardHeader>
                    <CardTitle as="h2">Products ({data.products.length})</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <DataTable
                      nested
                      columns={[
                        {
                          key: "denom",
                          header: "Denomination",
                          render: p => (
                            <span className="block max-w-[240px] truncate" title={p.name}>
                              {p.name}
                            </span>
                          ),
                        },
                        {
                          key: "product",
                          header: "Product",
                          render: p => (
                            <span className="block max-w-[240px] truncate" title={p.product?.name ?? undefined}>
                              {p.product?.name ?? "—"}
                            </span>
                          ),
                        },
                      ]}
                      data={data.products}
                      keyExtractor={p => p.id}
                      onRowClick={p => navigate(`/catalog/${p.id}`)}
                      empty={<EmptyState icon={PackageSearch} title="No matching products." description="Try a different search term." />}
                    />
                  </CardContent>
                </Card>
              </section>
            </>
          )}
        </>
      )}
    </PageLayout>
  );
}
