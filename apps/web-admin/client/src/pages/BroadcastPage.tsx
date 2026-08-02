import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { StatusBadge } from "../components/shared/StatusBadge";
import { Megaphone, X, MoreVertical, Send, Trash2, MessageSquare } from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { apiPost } from "../api/client";
import { describeError } from "../lib/errorMessages";
import { ImageUploadField } from "../components/shared/ImageUploadField";

interface BroadcastRow {
  id: number;
  message: string;
  segment: string;
  status: string;
  total: number;
  sent: number;
  scheduledAtDisplay: string | null;
  webImageUrl: string | null;
  failureReason: string | null;
}

interface BroadcastData {
  segments: string[];
  counts: Record<string, number>;
  history: BroadcastRow[];
}

const TEMPLATES: Record<string, string> = {
  Restock: "Good news! [Product name] is back in stock. Grab yours before it sells out again — order now!",
  "Flash Sale": "⚡ FLASH SALE — [X]% off [Product name] for a limited time! Ends [date/time]. Don't miss out!",
  "New Product": "🆕 Just added: [Product name]! Check it out in the catalog and be among the first to grab it.",
  Maintenance: "We'll be performing scheduled maintenance on [date/time]. The bot/site may be briefly unavailable. Thanks for your patience!",
  Promotion: "🎉 Special offer: use code [CODE] for [X]% off your next order. Valid until [date].",
  Custom: "",
};

function TelegramPreview({ message, imageUrl }: { message: string; imageUrl: string | null }) {
  return (
    <Card>
      <CardHeader><CardTitle as="h2">Preview</CardTitle></CardHeader>
      <CardContent>
        {message.trim() ? (
          <div className="rounded-xl bg-sand p-4">
            <div className="max-w-[320px] rounded-lg bg-card p-3 shadow-soft">
              {imageUrl && <img src={imageUrl} alt="" className="mb-2 max-h-48 w-full rounded object-cover" />}
              <p className="whitespace-pre-wrap text-sm text-ink">{message}</p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 rounded-xl bg-sand py-10 text-center">
            <MessageSquare className="h-8 w-8 text-ink-faint" />
            <p className="text-sm text-ink-soft">Your message preview will appear here.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Poll cadence while a broadcast is still queued or mid-send. */
const IN_FLIGHT_POLL_MS = 4_000;

/** Statuses that can still change on their own — the actual sending happens in
 *  the order-bot process, so nothing tells this page about it. */
const isInFlight = (status: string) => status === "PENDING" || status === "SENDING";

function useBroadcast() {
  return useQuery<BroadcastData>({
    queryKey: ["broadcast"],
    queryFn: async () => {
      const res = await fetch("/api/broadcast");
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<BroadcastData>;
    },
    // Refetch ONLY while something is actually in flight, so the Sent counter
    // the drainer writes every 25 recipients is visible without a manual
    // reload — and so an idle History table costs nothing once everything has
    // settled to SENT/FAILED/CANCELLED/DRAFT.
    refetchInterval: (query) =>
      query.state.data?.history.some((row) => isInFlight(row.status)) ? IN_FLIGHT_POLL_MS : false,
  });
}

export function BroadcastPage() {
  const qc = useQueryClient();
  const { data, isError } = useBroadcast();
  const [form, setForm] = useState({ message: "", segment: "", scheduled_at: "", webImageUrl: "" });
  const maxMessage = form.webImageUrl ? 1024 : 4000;
  const overLimit = form.message.length > maxMessage;

  const [pendingSendNow, setPendingSendNow] = useState<BroadcastRow | null>(null);
  const [pendingDeleteDraft, setPendingDeleteDraft] = useState<BroadcastRow | null>(null);
  const [pendingCancel, setPendingCancel] = useState<BroadcastRow | null>(null);

  const send = useMutation({
    mutationFn: () => apiPost("/api/broadcast", {
      message: form.message,
      segment: form.segment,
      scheduled_at: form.scheduled_at,
      image_url: form.webImageUrl,
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["broadcast"] });
      setForm({ message: "", segment: "", scheduled_at: "", webImageUrl: "" });
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const cancel = useMutation({
    mutationFn: (id: number) => apiPost(`/api/broadcast/${id}/cancel`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["broadcast"] });
      toast.success("Broadcast cancelled.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const saveDraft = useMutation({
    mutationFn: () => apiPost("/api/broadcast", {
      message: form.message,
      segment: form.segment,
      scheduled_at: "",
      image_url: form.webImageUrl,
      draft: true,
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["broadcast"] });
      setForm({ message: "", segment: "", scheduled_at: "", webImageUrl: "" });
      toast.success("Draft saved.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const queueDraft = useMutation({
    mutationFn: (id: number) => apiPost(`/api/broadcast/${id}/queue`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["broadcast"] });
      toast.success("Broadcast queued to send.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const deleteDraft = useMutation({
    mutationFn: (id: number) => apiPost(`/api/broadcast/${id}/delete`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["broadcast"] });
      toast.success("Draft deleted.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  if (isError) return <PageLayout title="Broadcast"><p className="text-sm text-rust">Failed to load broadcast.</p></PageLayout>;

  return (
    <PageLayout title="Broadcast">
      <PageHeader
        title="Broadcast"
        description="Send announcements, promotions, product updates, and offers to selected customer segments."
      />

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[3fr_2fr]">
        <Card>
          <CardHeader><CardTitle as="h2">Compose Broadcast</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-4">
            {/* Quick Templates */}
            <div className="flex flex-wrap gap-2">
              {Object.keys(TEMPLATES).map(name => (
                <Button
                  key={name} type="button" variant="outline" size="sm"
                  onClick={() => setForm(f => ({ ...f, message: TEMPLATES[name] ?? "" }))}
                >
                  {name}
                </Button>
              ))}
            </div>

            {/* Message + Image */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="flex flex-col gap-1">
                <Textarea
                  placeholder={form.webImageUrl ? "Caption (max 1024 chars with an image)" : "Write your broadcast message..."}
                  value={form.message}
                  onChange={e => setForm(f => ({ ...f, message: e.target.value }))}
                  rows={8}
                />
                <p className={`self-end text-xs ${overLimit ? "text-rust" : "text-ink-soft"}`}>
                  {form.message.length} / {maxMessage}
                  {overLimit ? ` — too long for ${form.webImageUrl ? "a photo caption" : "a broadcast"}` : ""}
                </p>
              </div>
              <ImageUploadField
                variant="dropzone"
                label="Image (optional)"
                imageUrl={form.webImageUrl}
                uploadPath="/broadcast/photo"
                fieldName="photo"
                accept="image/jpeg,image/png,image/webp"
                maxBytes={5 * 1024 * 1024}
                onUploaded={url => setForm(f => ({ ...f, webImageUrl: url }))}
                onRemove={() => setForm(f => ({ ...f, webImageUrl: "" }))}
              />
            </div>

            {/* Segment + Schedule */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-ink-soft">Segment</label>
                <Select
                  value={form.segment || "_none_"}
                  onValueChange={v => setForm(f => ({ ...f, segment: v === "_none_" ? "" : v }))}
                >
                  <SelectTrigger className="w-full"><SelectValue placeholder="— pick segment —" /></SelectTrigger>
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
                />
                <p className="text-xs text-ink-soft">Leave empty to send immediately.</p>
                {form.scheduled_at && (
                  <p className="text-xs text-ink-soft">Note: schedule is ignored if you Save Draft instead — drafts send immediately once queued.</p>
                )}
              </div>
            </div>

            {/* Actions */}
            <div className="flex flex-wrap gap-2">
              <ConfirmDialog
                trigger={
                  <Button disabled={!form.message || !form.segment || overLimit || send.isPending}>
                    Send Broadcast
                  </Button>
                }
                title={form.scheduled_at ? "Schedule broadcast?" : "Send broadcast now?"}
                description={`This will ${form.scheduled_at ? "schedule a" : "immediately send a"} broadcast to ${data?.counts[form.segment] ?? 0} ${form.segment} users. This cannot be undone.`}
                confirmLabel={form.scheduled_at ? "Schedule" : "Send"}
                variant="default"
                onConfirm={() => send.mutate()}
              />
              <Button
                type="button" variant="secondary"
                disabled={!form.message || !form.segment || overLimit || saveDraft.isPending}
                onClick={() => saveDraft.mutate()}
              >
                Save Draft
              </Button>
            </div>
          </CardContent>
        </Card>

        <TelegramPreview message={form.message} imageUrl={form.webImageUrl || null} />
      </div>

      <div className="mt-8">
        <h2 className="text-sm font-semibold text-ink">History</h2>
        <p className="mb-3 text-xs text-ink-soft">Recent broadcast activity.</p>
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
              key: "image",
              header: "Image",
              render: b => b.webImageUrl
                ? <img src={b.webImageUrl} alt="" className="h-8 w-8 object-cover rounded border border-line" />
                : <span className="text-xs text-ink-soft">—</span>,
            },
            {
              key: "segment",
              header: "Segment",
              render: b => b.segment,
            },
            {
              key: "status",
              header: "Status",
              render: b => (
                <div className="flex flex-col gap-0.5">
                  <StatusBadge status={b.status} />
                  {b.status === "FAILED" && b.failureReason && (
                    <span className="text-xs text-ink-faint">{b.failureReason}</span>
                  )}
                </div>
              ),
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
                <span className="text-xs text-ink-soft">
                  {b.scheduledAtDisplay ?? "immediate"}
                </span>
              ),
            },
            {
              key: "actions",
              header: "",
              render: b => {
                if (b.status !== "DRAFT" && b.status !== "PENDING") return null;
                return (
                  <div onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`Actions for broadcast ${b.id}`}>
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {b.status === "DRAFT" && (
                          <>
                            <DropdownMenuItem onSelect={() => setPendingSendNow(b)}>
                              <Send className="h-4 w-4" /> Send Now
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => setPendingDeleteDraft(b)} className="text-rust">
                              <Trash2 className="h-4 w-4" /> Delete draft
                            </DropdownMenuItem>
                          </>
                        )}
                        {b.status === "PENDING" && (
                          <DropdownMenuItem onSelect={() => setPendingCancel(b)} className="text-rust">
                            <X className="h-4 w-4" /> Cancel
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                );
              },
            },
          ]}
          data={data?.history ?? []}
          isLoading={!data}
          keyExtractor={b => b.id}
          empty={
            <EmptyState
              icon={Megaphone}
              title="No broadcasts yet"
              description="Sent and scheduled broadcasts will appear here."
            />
          }
        />
      </div>

      {pendingSendNow && (
        <ConfirmDialog
          open onOpenChange={(o) => { if (!o) setPendingSendNow(null); }}
          title="Send this broadcast now?"
          description={`This will immediately queue the draft to ${pendingSendNow.total} recipient(s) in segment "${pendingSendNow.segment}". This cannot be undone.`}
          confirmLabel="Send Now"
          variant="default"
          onConfirm={() => { queueDraft.mutate(pendingSendNow.id); setPendingSendNow(null); }}
        />
      )}
      {pendingDeleteDraft && (
        <ConfirmDialog
          open onOpenChange={(o) => { if (!o) setPendingDeleteDraft(null); }}
          title="Delete this draft?"
          description="This draft was never sent — deleting it is permanent, but nothing was delivered to customers."
          confirmLabel="Delete draft"
          onConfirm={() => { deleteDraft.mutate(pendingDeleteDraft.id); setPendingDeleteDraft(null); }}
        />
      )}
      {pendingCancel && (
        <ConfirmDialog
          open onOpenChange={(o) => { if (!o) setPendingCancel(null); }}
          title="Cancel broadcast?"
          description="This will stop the scheduled broadcast."
          confirmLabel="Cancel broadcast"
          onConfirm={() => { cancel.mutate(pendingCancel.id); setPendingCancel(null); }}
        />
      )}
    </PageLayout>
  );
}
