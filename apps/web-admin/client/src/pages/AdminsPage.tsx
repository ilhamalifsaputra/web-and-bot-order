import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { FilterBar } from "../components/shared/FilterBar";
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
import { apiPost } from "../api/client";

interface AdminRow {
  telegramId: number;
  role: string;
  passwordSet: boolean;
  twoFa: boolean;
  hasSession: boolean;
  name: string | null;
  isSelf: boolean;
  fromEnv: boolean;
}

function useAdmins() {
  return useQuery<{ admins: AdminRow[]; roles: string[] }>({
    queryKey: ["admins"],
    queryFn: async () => {
      const res = await fetch("/api/admins");
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<{ admins: AdminRow[]; roles: string[] }>;
    },
  });
}

export function AdminsPage() {
  const qc = useQueryClient();
  const { data, isError } = useAdmins();
  const [addId, setAddId] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () => apiPost("/api/admins/add", { telegram_id: addId }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["admins"] }); setAddId(""); setAddError(null); },
    onError: (e: Error) => setAddError(e.message),
  });

  const remove = useMutation({
    mutationFn: (tgId: number) => apiPost("/api/admins/remove", { telegram_id: String(tgId) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["admins"] }); },
    onError: (e: Error) => alert(e.message),
  });

  const setRole = useMutation({
    mutationFn: ({ tgId, role }: { tgId: number; role: string }) =>
      apiPost(`/api/admins/${tgId}/role`, { role }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["admins"] }); },
    onError: (e: Error) => alert(e.message),
  });

  const forceLogout = useMutation({
    mutationFn: (tgId: number) => apiPost(`/api/admins/${tgId}/logout`, {}),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["admins"] }); },
    onError: (e: Error) => alert(e.message),
  });

  if (isError) return <PageLayout title="Admins"><p className="text-sm text-rust">Failed to load admins.</p></PageLayout>;

  return (
    <PageLayout title="Admins">
      <PageHeader title="Admins" />

      <FilterBar className="mb-6">
        <Input
          placeholder="Telegram ID"
          value={addId}
          onChange={e => setAddId(e.target.value)}
          className="w-44"
        />
        <Button onClick={() => add.mutate()} disabled={!addId || add.isPending}>
          + Add Admin
        </Button>
        {addError && <span className="text-sm text-rust">{addError}</span>}
      </FilterBar>

      <DataTable
        columns={[
          {
            key: "tid",
            header: "Telegram ID",
            render: a => (
              <span className="font-mono text-sm">
                {a.telegramId}{a.isSelf ? <Badge className="ml-2">You</Badge> : ""}
              </span>
            ),
          },
          {
            key: "name",
            header: "Name",
            render: a => a.name ?? "—",
          },
          {
            key: "role",
            header: "Role",
            render: a => (
              <Select
                value={a.role}
                onValueChange={role => setRole.mutate({ tgId: a.telegramId, role })}
                disabled={a.isSelf}
              >
                <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(data?.roles ?? []).map(r => (
                    <SelectItem key={r} value={r}>{r}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ),
          },
          {
            key: "pwd",
            header: "Pwd",
            render: a => a.passwordSet
              ? <Badge variant="default">✓</Badge>
              : <span className="text-ink-faint">—</span>,
          },
          {
            key: "twofa",
            header: "2FA",
            render: a => a.twoFa
              ? <Badge variant="default">✓</Badge>
              : <span className="text-ink-faint">—</span>,
          },
          {
            key: "session",
            header: "Session",
            render: a => a.hasSession ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => forceLogout.mutate(a.telegramId)}
                disabled={a.isSelf}
              >
                Logout
              </Button>
            ) : "—",
          },
          {
            key: "actions",
            header: "",
            render: a => !a.fromEnv && !a.isSelf ? (
              <ConfirmDialog
                trigger={<Button variant="ghost" size="sm" className="text-rust">Remove</Button>}
                title="Remove admin?"
                description={`Remove admin ${a.telegramId} from the system.`}
                confirmLabel="Remove"
                onConfirm={() => remove.mutate(a.telegramId)}
              />
            ) : null,
          },
        ]}
        data={data?.admins ?? []}
        isLoading={!data}
        keyExtractor={a => a.telegramId}
        empty={<EmptyState title="No admins" />}
      />
    </PageLayout>
  );
}
