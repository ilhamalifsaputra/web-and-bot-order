import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { FilterBar } from "../components/shared/FilterBar";
import { Shield, Check, Plus, LogOut, Trash2 } from "lucide-react";
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
import { toast } from "sonner";
import { apiPost } from "../api/client";
import { describeError } from "../lib/errorMessages";
import { useAdmins } from "../hooks/useAdmins";

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
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admins"] });
      toast.success("Admin removed.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const setRole = useMutation({
    mutationFn: ({ tgId, role }: { tgId: number; role: string }) =>
      apiPost(`/api/admins/${tgId}/role`, { role }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admins"] });
      toast.success("Admin role updated.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const forceLogout = useMutation({
    mutationFn: (tgId: number) => apiPost(`/api/admins/${tgId}/logout`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admins"] });
      toast.success("Admin logged out.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  if (isError) return <PageLayout title="Admins"><p className="text-sm text-rust">Failed to load admins.</p></PageLayout>;

  return (
    <PageLayout title="Admins">
      <PageHeader title="Admins" />

      {/* F-006: brought up to the same Label-above-field treatment used by
       *  Vouchers' inline "New Voucher" form (post F-014) and the
       *  Product/Denomination dedicated-page forms, instead of a bare
       *  placeholder-only textbox — same "+ Add Admin" create endpoint,
       *  presentation only. */}
      <FilterBar className="mb-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="admin-telegram-id" className="text-xs font-medium text-ink">
            Telegram ID <span className="text-rust">*</span>
          </label>
          <Input
            id="admin-telegram-id"
            placeholder="e.g. 123456789"
            value={addId}
            onChange={e => setAddId(e.target.value)}
            className="w-44"
          />
        </div>
        <Button onClick={() => add.mutate()} disabled={!addId || add.isPending}>
          <Plus className="h-4 w-4" />
          Add Admin
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
            header: "Password Set",
            render: a => a.passwordSet
              ? <Badge variant="default"><Check /></Badge>
              : <span className="text-ink-faint">—</span>,
          },
          {
            key: "twofa",
            header: "2FA",
            render: a => a.twoFa
              ? <Badge variant="default"><Check /></Badge>
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
                <LogOut className="h-4 w-4" />
                Logout
              </Button>
            ) : "—",
          },
          {
            key: "actions",
            header: "",
            render: a => !a.fromEnv && !a.isSelf ? (
              <ConfirmDialog
                trigger={<Button variant="ghost" size="sm" className="text-rust"><Trash2 className="h-4 w-4" />Remove</Button>}
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
        empty={<EmptyState icon={Shield} title="No admins" />}
      />
    </PageLayout>
  );
}
