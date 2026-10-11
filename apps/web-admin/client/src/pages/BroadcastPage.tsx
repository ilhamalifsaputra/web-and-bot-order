import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Megaphone, MessageSquare, MoreVertical, Send, Trash2, X } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { apiGet, apiPost } from "../api/client";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { ImageUploadField } from "../components/shared/ImageUploadField";
import { PageHeader } from "../components/shared/PageHeader";
import { PageLayout } from "../components/shared/PageLayout";
import { StatusBadge } from "../components/shared/StatusBadge";
import { describeError } from "../lib/errorMessages";

interface BroadcastRow {
  id: number;
  message: string;
  segment: string;
  status: string;
  total: number;
  sent: number;
  failed: number;
  /** Server-computed: this row is PENDING and its schedule has come round (or
   *  it never had one), so the drainer should be picking it up any moment. */
  isDue: boolean;
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
              <p className="whitespace-pre-wrap break-words text-sm text-ink">{message}</p>
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

/** Rows that can still change on their own within seconds — the actual sending
 *  happens in the order-bot process, so nothing tells this page about it.
 *  A PENDING row only counts once it is DUE: a broadcast scheduled for next
 *  week is PENDING for days, and polling this page's (expensive) endpoint every
 *  few seconds that whole time buys nothing. */
const isInFlight = (row: BroadcastRow) =>
  row.status === "SENDING" || (row.status === "PENDING" && row.isDue);

function useBroadcast() {
  return useQuery<BroadcastData>({
    queryKey: ["broadcast"],
    queryFn: () => apiGet<BroadcastData>("/api/broadcast"),
    // Refetch ONLY while something is actually in flight, so the Sent counter
    // the drainer writes every 25 recipients is visible without a manual
    // reload — and so an idle History table costs nothing once everything has
    // settled to SENT/FAILED/CANCELLED/DRAFT.
    refetchInterval: (query) =>
      query.state.data?.history.some(isInFlight) ? IN_FLIGHT_POLL_MS : false,
  });
}

export function BroadcastPage() {
  const fieldId = useId();
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
    onError: (e: Error) => toast.error(describeError(e)),
  });

  const cancel = useMutation({
    mutationFn: (id: number) => apiPost(`/api/broadcast/${id}/cancel`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["broadcast"] });
      toast.success("Broadcast cancelled.");
    },
    onError: (e: Error) => toast.error(describeError(e)),
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
    onError: (e: Error) => toast.error(describeError(e)),
  });

  const queueDraft = useMutation({
    mutationFn: (id: number) => apiPost(`/api/broadcast/${id}/queue`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["broadcast"] });
      toast.success("Broadcast queued to send.");
    },
    onError: (e: Error) => toast.error(describeError(e)),
  });

  const deleteDraft = useMutation({
    mutationFn: (id: number) => apiPost(`/api/broadcast/${id}/delete`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["broadcast"] });
      toast.success("Draft deleted.");
    },
    onError: (e: Error) => toast.error(describeError(e)),
  });

  if (isError) return <PageLayout title="Broadcast"><p className="text-sm text-rust">Failed to load broadcast.</p></PageLayout>;

  return (
    <PageLayout title="Broadcast">
      <PageHeader
        title="Broadcast"
        description="Send announcements, promotions, product updates, and offers to selected customer segments."
      />

      <BroadcastEditorLayout setForm={setForm} form={form} overLimit={overLimit} maxMessage={maxMessage} fieldId={fieldId} data={data} send={send} saveDraft={saveDraft} />

      <BroadcastHistory setPendingSendNow={setPendingSendNow} setPendingDeleteDraft={setPendingDeleteDraft} setPendingCancel={setPendingCancel} data={data} />

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

function BroadcastEditorLayout({ setForm, form, overLimit, maxMessage, fieldId, data, send, saveDraft }: {
  setForm: import("react").Dispatch<import("react").SetStateAction<{ message: string; segment: string; scheduled_at: string; webImageUrl: string; }>>;
  form: { message: string; segment: string; scheduled_at: string; webImageUrl: string; };
  overLimit: boolean;
  maxMessage: 1024 | 4000;
  fieldId: string;
  data: NoInfer<BroadcastData> | undefined;
  send: import("@tanstack/react-query").UseMutationResult<unknown, Error, void, unknown>;
  saveDraft: import("@tanstack/react-query").UseMutationResult<unknown, Error, void, unknown>;
}) {
  return (<div className="grid grid-cols-1 gap-8 lg:grid-cols-[3fr_2fr]">
    <BroadcastComposerCard setForm={setForm} form={form} overLimit={overLimit} maxMessage={maxMessage} fieldId={fieldId} data={data} send={send} saveDraft={saveDraft} />

    <TelegramPreview message={form.message} imageUrl={form.webImageUrl || null} />
  </div>);
}

function BroadcastHistory({ setPendingSendNow, setPendingDeleteDraft, setPendingCancel, data }: {
  setPendingSendNow: import("react").Dispatch<import("react").SetStateAction<BroadcastRow | null>>;
  setPendingDeleteDraft: import("react").Dispatch<import("react").SetStateAction<BroadcastRow | null>>;
  setPendingCancel: import("react").Dispatch<import("react").SetStateAction<BroadcastRow | null>>;
  data: NoInfer<BroadcastData> | undefined;
}) {
  return (<div className="mt-8">
    <Card>
      <CardHeader><CardTitle as="h2">History</CardTitle></CardHeader>
      <CardContent>
        <p className="mb-3 text-xs text-ink-soft">Recent broadcast activity.</p>
        <DataTable
          nested
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
              render: b => (
                <span>
                  {b.sent}/{b.total}
                  {b.failed > 0 && <span className="text-rust"> ({b.failed} failed)</span>}
                </span>
              ),
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
      </CardContent>
    </Card>
  </div>);
}

function BroadcastComposerCard({ setForm, form, overLimit, maxMessage, fieldId, data, send, saveDraft }: {
  setForm: import("react").Dispatch<import("react").SetStateAction<{ message: string; segment: string; scheduled_at: string; webImageUrl: string; }>>;
  form: { message: string; segment: string; scheduled_at: string; webImageUrl: string; };
  overLimit: boolean;
  maxMessage: 1024 | 4000;
  fieldId: string;
  data: NoInfer<BroadcastData> | undefined;
  send: import("@tanstack/react-query").UseMutationResult<unknown, Error, void, unknown>;
  saveDraft: import("@tanstack/react-query").UseMutationResult<unknown, Error, void, unknown>;
}) {
  return (<Card>
    <CardHeader><CardTitle as="h2">Compose Broadcast</CardTitle></CardHeader>
    <BroadcastComposerFields setForm={setForm} form={form} overLimit={overLimit} maxMessage={maxMessage} fieldId={fieldId} data={data} send={send} saveDraft={saveDraft} />
  </Card>);
}

function BroadcastComposerFields({ setForm, form, overLimit, maxMessage, fieldId, data, send, saveDraft }: {
  setForm: import("react").Dispatch<import("react").SetStateAction<{ message: string; segment: string; scheduled_at: string; webImageUrl: string; }>>;
  form: { message: string; segment: string; scheduled_at: string; webImageUrl: string; };
  overLimit: boolean;
  maxMessage: 1024 | 4000;
  fieldId: string;
  data: NoInfer<BroadcastData> | undefined;
  send: import("@tanstack/react-query").UseMutationResult<unknown, Error, void, unknown>;
  saveDraft: import("@tanstack/react-query").UseMutationResult<unknown, Error, void, unknown>;
}) {
  return (<CardContent className="flex flex-col gap-4">
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
    <BroadcastMessageFields form={form} setForm={setForm} overLimit={overLimit} maxMessage={maxMessage} />

    {/* Segment + Schedule */}
    <BroadcastAudienceAndSchedule fieldId={fieldId} form={form} setForm={setForm} data={data} />

    {/* Actions */}
    <BroadcastActions form={form} overLimit={overLimit} send={send} data={data} saveDraft={saveDraft} />
  </CardContent>);
}

function BroadcastMessageFields({ form, setForm, overLimit, maxMessage }: {
  form: { message: string; segment: string; scheduled_at: string; webImageUrl: string; };
  setForm: import("react").Dispatch<import("react").SetStateAction<{ message: string; segment: string; scheduled_at: string; webImageUrl: string; }>>;
  overLimit: boolean;
  maxMessage: 1024 | 4000;
}) {
  return (<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
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
  </div>);
}

function BroadcastAudienceAndSchedule({ fieldId, form, setForm, data }: {
  fieldId: string;
  form: { message: string; segment: string; scheduled_at: string; webImageUrl: string; };
  setForm: import("react").Dispatch<import("react").SetStateAction<{ message: string; segment: string; scheduled_at: string; webImageUrl: string; }>>;
  data: NoInfer<BroadcastData> | undefined;
}) {
  return (<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
    <div className="flex flex-col gap-1">
      <label htmlFor={`${fieldId}-segment-1`} className="text-xs text-ink-soft">Segment</label>
      <Select
        value={form.segment || "_none_"}
        onValueChange={v => setForm(f => ({ ...f, segment: v === "_none_" ? "" : v }))}
      >
        <SelectTrigger id={`${fieldId}-segment-1`} className="w-full"><SelectValue placeholder="— pick segment —" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="_none_">— pick segment —</SelectItem>
          {(data?.segments ?? []).map(s => (
            <SelectItem key={s} value={s}>{s} ({data?.counts[s] ?? 0})</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
    <div className="flex flex-col gap-1">
      <label htmlFor={`${fieldId}-schedule-optional-2`} className="text-xs text-ink-soft">Schedule (optional)</label>
      <Input id={`${fieldId}-schedule-optional-2`}
        type="datetime-local"
        value={form.scheduled_at}
        onChange={e => setForm(f => ({ ...f, scheduled_at: e.target.value }))}
      />
      <p className="text-xs text-ink-soft">Leave empty to send immediately.</p>
      {form.scheduled_at && (
        <p className="text-xs text-ink-soft">Note: schedule is ignored if you Save Draft instead — drafts send immediately once queued.</p>
      )}
    </div>
  </div>);
}

function BroadcastActions({ form, overLimit, send, data, saveDraft }: {
  form: { message: string; segment: string; scheduled_at: string; webImageUrl: string; };
  overLimit: boolean;
  send: import("@tanstack/react-query").UseMutationResult<unknown, Error, void, unknown>;
  data: NoInfer<BroadcastData> | undefined;
  saveDraft: import("@tanstack/react-query").UseMutationResult<unknown, Error, void, unknown>;
}) {
  return (<div className="flex flex-wrap gap-2">
    <ConfirmDialog
      trigger={
        <Button
          disabled={!form.message || !form.segment || overLimit || send.isPending || !data}
        >
          Send Broadcast
        </Button>
      }
      title={form.scheduled_at ? "Schedule broadcast?" : "Send broadcast now?"}
      description={`This will ${form.scheduled_at ? "schedule a" : "immediately send a"} broadcast to ${data?.counts[form.segment] ?? 0} Telegram users in the ${form.segment} segment. This cannot be undone.`}
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
  </div>);
}
