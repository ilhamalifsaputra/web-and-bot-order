import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { FilterBar } from "../components/shared/FilterBar";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Users } from "lucide-react";

interface UserRow {
  id: number;
  username: string | null;
  fullName: string | null;
  telegramId: string;
  role: string;
  banned: boolean;
  createdAt: string;
}

function useUsers(q: string) {
  return useQuery<{ users: UserRow[]; q: string }>({
    queryKey: ["users", q],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      const res = await fetch(`/api/users?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<{ users: UserRow[]; q: string }>;
    },
  });
}

export function UsersPage() {
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const { data, isLoading, isError } = useUsers(q);

  if (isError) {
    return (
      <PageLayout title="Customers">
        <p className="text-rust">Failed to load customers.</p>
      </PageLayout>
    );
  }

  return (
    <PageLayout title="Customers">
      <PageHeader title="Customers" />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setQ(input.trim());
        }}
        className="mb-4"
      >
        <FilterBar>
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Search by name, username, Telegram ID…"
            className="w-80"
          />
          <Button type="submit">Search</Button>
          {q && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setInput("");
                setQ("");
              }}
            >
              Clear
            </Button>
          )}
        </FilterBar>
      </form>

      <DataTable
        columns={[
          {
            key: "name",
            header: "Name",
            render: (row) => (
              <div>
                <div className="font-medium text-sm text-ink">
                  {row.fullName ?? "—"}
                </div>
                <div className="text-xs text-ink-soft">
                  {row.username ? `@${row.username}` : ""}
                </div>
              </div>
            ),
          },
          {
            key: "telegramId",
            header: "Telegram ID",
            render: (row) => (
              <span className="font-mono text-xs text-ink-soft">
                {row.telegramId}
              </span>
            ),
          },
          {
            key: "role",
            header: "Role",
            render: (row) => <Badge variant="outline">{row.role}</Badge>,
          },
          {
            key: "status",
            header: "Status",
            render: (row) =>
              row.banned ? (
                <Badge variant="destructive">Banned</Badge>
              ) : null,
          },
          {
            key: "joined",
            header: "Joined",
            render: (row) => (
              <span className="text-xs text-ink-soft">
                {new Date(row.createdAt).toLocaleDateString()}
              </span>
            ),
          },
        ]}
        data={data?.users ?? []}
        isLoading={isLoading}
        keyExtractor={(row) => row.id}
        onRowClick={(row) => navigate(`/users/${row.id}`)}
        empty={<EmptyState icon={Users} title="No customers yet" />}
      />
    </PageLayout>
  );
}
