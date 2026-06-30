import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { StatusBadge } from "../components/shared/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { apiPost } from "../api/client";

interface BroadcastRow {
  id: number;
  message: string;
  segment: string;
  status: string;
  total: number;
  sent: number;
  scheduledAt: string | null;
  createdAt: string;
}

interface BroadcastData {
  segments: string[];
  counts: Record<string, number>;
  history: BroadcastRow[];
}

function useBroadcast() {
  return useQuery<BroadcastData>({
    queryKey: ["broadcast"],
    queryFn: async () => {
      const res = await fetch("/api/broadcast");
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<BroadcastData>;
    },
  });
}

export function BroadcastPage() {
  const qc = useQueryClient();
  const { data, isError } = useBroadcast();
  const [form, setForm] = useState({ message: "", segment: "", scheduled_at: "" });
  const [formError, setFormError] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: () => apiPost("/api/broadcast", form),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["broadcast"] });
      setForm({ message: "", segment: "", scheduled_at: "" });
      setFormError(null);
    },
    onError: (e: Error) => setFormError(e.message),
  });

  const cancel = useMutation({
    mutationFn: (id: number) => apiPost(`/api/broadcast/${id}/cancel`, {}),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["broadcast"] }); },
    onError: (e: Error) => alert(e.message),
  });

  if (isError) return <PageLayout title="Broadcast"><p className="text-sm text-rust">Failed to load broadcast.</p></PageLayout>;

  return (
    <PageLayout title="Broadcast">
      <PageHeader title="Broadcast" />

      <Card className="mb-6">
        <CardHeader><CardTitle>Compose Broadcast</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          {formError && <p className="text-sm text-rust">{formError}</p>}
          <Textarea
            placeholder="Message (max 4000 chars)"
            value={form.message}
            onChange={e => setForm(f => ({ ...f, message: e.target.value }))}
            rows={5}
          />
          <div className="flex flex-wrap gap-2 items-end">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-ink-soft">Segment</label>
              <Select
                value={form.segment || "_none_"}
                onValueChange={v => setForm(f => ({ ...f, segment: v === "_none_" ? "" : v }))}
              >
                <SelectTrigger className="w-48"><SelectValue placeholder="— pick segment —" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="_none_">— pick segment —</SelectItem>
                  {(data?.segments ?? []).map(s => (
                    <SelectItem key={s} value={s}>{s} ({data?.counts[s] ?? 0})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-ink-soft">Schedule (optional)</label>
              <Input
                type="datetime-local"
                value={form.scheduled_at}
                onChange={e => setForm(f => ({ ...f, scheduled_at: e.target.value }))}
                className="w-52"
              />
            </div>
            <ConfirmDialog
              trigger={
                <Button disabled={!form.message || !form.segment || send.isPending}>
                  {form.scheduled_at ? "Schedule" : "Send now"}
                </Button>
              }
              title={form.scheduled_at ? "Schedule broadcast?" : "Send broadcast now?"}
              description={`This will ${form.scheduled_at ? "schedule a" : "immediately send a"} broadcast to ${data?.counts[form.segment] ?? 0} ${form.segment} users. This cannot be undone.`}
              confirmLabel={form.scheduled_at ? "Schedule" : "Send"}
              variant="default"
              onConfirm={() => send.mutate()}
            />
          </div>
        </CardContent>
      </Card>

      <h2 className="text-sm font-semibold text-ink mb-3">History</h2>

      <DataTable
        columns={[
          {
            key: "message",
            header: "Message",
            render: b => (
              <span className="text-sm text-ink truncate max-w-[240px] block">
                {b.message.slice(0, 80)}{b.message.length > 80 ? "…" : ""}
              </span>
            ),
          },
          {
            key: "segment",
            header: "Segment",
            render: b => b.segment,
          },
          {
            key: "status",
            header: "Status",
            render: b => <StatusBadge status={b.status} />,
          },
          {
            key: "sent",
            header: "Sent",
            render: b => `${b.sent}/${b.total}`,
          },
          {
            key: "scheduled",
            header: "Scheduled",
            render: b => (
              <span className="text-xs text-ink-faint">
                {b.scheduledAt ? new Date(b.scheduledAt).toLocaleString() : "immediate"}
              </span>
            ),
          },
          {
            key: "actions",
            header: "",
            render: b => b.status === "PENDING" ? (
              <ConfirmDialog
                trigger={<Button variant="ghost" size="sm" className="text-rust">Cancel</Button>}
                title="Cancel broadcast?"
                description="This will stop the scheduled broadcast."
                confirmLabel="Cancel broadcast"
                onConfirm={() => cancel.mutate(b.id)}
              />
            ) : null,
          },
        ]}
        data={data?.history ?? []}
        isLoading={!data}
        keyExtractor={b => b.id}
        empty={<EmptyState title="No broadcasts yet" />}
      />
    </PageLayout>
  );
}
