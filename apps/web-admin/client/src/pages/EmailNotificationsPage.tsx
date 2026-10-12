import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { apiGet, apiPost } from "@/api/client";
import { SettingsToggle } from "@/components/shared/SettingsToggle";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLayout } from "@/components/shared/PageLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface EmailEventRow {
  key: string;
  label: string;
  description: string;
  category: string;
  audience: string;
  enabled: boolean;
  mandatory: boolean;
}
interface EmailNotificationData {
  events: EmailEventRow[];
  configured: boolean;
  policy: string;
  schedule?: ReportSchedule;
}

interface ReportSchedule { timezone: string; dailyTime: string; weeklyDay: number; weeklyTime: string }

function ReportScheduleForm({ schedule }: { schedule: ReportSchedule }) {
  const client = useQueryClient();
  const [changes, setDraft] = useState<Partial<ReportSchedule>>({});
  const draft = { ...schedule, ...changes };
  const save = useMutation({ mutationFn: () => apiPost("/api/settings/email-notifications/schedule", draft), onSuccess: () => { void client.invalidateQueries({ queryKey: ["email-notifications"] }); } });
  return <Card><CardHeader><CardTitle as="h2">Report schedule</CardTitle></CardHeader><CardContent>
    <form className="grid gap-4 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <div><label htmlFor="report-timezone" className="text-sm font-medium text-ink">Report timezone</label><Input id="report-timezone" value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })} required /></div>
      <div><label htmlFor="report-daily-time" className="text-sm font-medium text-ink">Daily report time</label><Input id="report-daily-time" type="time" value={draft.dailyTime} onChange={(event) => setDraft({ ...draft, dailyTime: event.target.value })} required /></div>
      <div><label htmlFor="report-weekly-day" className="text-sm font-medium text-ink">Weekly report day</label><select id="report-weekly-day" className="mt-1 w-full rounded-lg border border-input bg-card p-2 text-sm text-ink" value={draft.weeklyDay} onChange={(event) => setDraft({ ...draft, weeklyDay: Number(event.target.value) })}>{["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((day, value) => <option key={day} value={value}>{day}</option>)}</select></div>
      <div><label htmlFor="report-weekly-time" className="text-sm font-medium text-ink">Weekly report time</label><Input id="report-weekly-time" type="time" value={draft.weeklyTime} onChange={(event) => setDraft({ ...draft, weeklyTime: event.target.value })} required /></div>
      <p className="text-xs text-ink-soft sm:col-span-2">Reports summarize closed periods. Enable daily and weekly emails separately below.</p>
      {save.isError && <p role="alert" className="text-xs text-rust sm:col-span-2">{save.error.message}</p>}
      {save.isSuccess && <p role="status" className="text-xs text-grass-dark">Schedule saved.</p>}
      <Button type="submit" disabled={save.isPending} className="justify-self-start">{save.isPending ? "Saving…" : "Save report schedule"}</Button>
    </form>
  </CardContent></Card>;
}

function EmailEventToggle({ event }: { event: EmailEventRow }) {
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (enabled: boolean) => apiPost("/api/settings/email-notifications", { key: event.key, enabled }),
    onMutate: () => setError(null),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ["email-notifications"] }); },
    onError: (err: Error) => setError(err.message),
  });
  return <div className="py-2">
    <div className="text-xs font-medium text-ink-soft">{event.audience === "admin" ? "Admin" : "Customer"}</div>
    <SettingsToggle id={`email-${event.key}`} label={event.label} description={event.description} checked={event.enabled} disabled={event.mandatory} pending={save.isPending} disabledReason={event.mandatory ? "Required for account recovery and security." : undefined} onCheckedChange={(enabled) => save.mutate(enabled)} />
    <EmailEventPreview event={event} />
    {error && <p role="alert" className="text-xs text-rust">{error}</p>}
  </div>;
}

function EmailEventPreview({ event }: { event: EmailEventRow }) {
  const [open, setOpen] = useState(false);
  const preview = useQuery({ queryKey: ["email-event-preview", event.key], queryFn: () => apiGet<{ subject: string; text: string }>(`/api/settings/email-notifications/${encodeURIComponent(event.key)}/preview`), enabled: open });
  const id = `preview-${event.key}`;
  return <div>
    <Button variant="ghost" size="sm" aria-label={`Preview ${event.label}`} aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)}>Preview template</Button>
    {open && <div id={id} className="mt-2 space-y-2 rounded-lg border border-line bg-sand p-3">
      <p className="text-xs text-ink-soft">Example content only. This preview does not send email.</p>
      {preview.isPending && <p role="status" className="text-xs text-ink-soft">Loading preview…</p>}
      {preview.isError && <p role="alert" className="text-xs text-rust">{preview.error.message}</p>}
      {preview.data && <><p className="text-sm font-medium text-ink">Subject: {preview.data.subject}</p><pre className="whitespace-pre-wrap break-words font-sans text-xs text-ink-soft">{preview.data.text}</pre></>}
    </div>}
  </div>;
}

interface DeliveryDiagnostics {
  inspected: number;
  transportAccepted: number;
  sentWithoutEvidence: number;
  noValidRecipient: number;
  recentOrdersInspected: number;
  recentOrdersWithoutEmail: number;
}

function EmailDiagnostics() {
  const [open, setOpen] = useState(false);
  const query = useQuery({ queryKey: ["email-delivery-diagnostics"], queryFn: () => apiGet<DeliveryDiagnostics>("/api/settings/email/diagnostics"), enabled: open });
  return <Card><CardHeader><CardTitle as="h2">Delivery diagnostics</CardTitle></CardHeader><CardContent className="space-y-2">
    <p className="text-xs text-ink-soft">Inspect recent delivery metadata. This check does not send or retry email.</p>
    <Button variant="outline" disabled={open && query.isFetching} onClick={() => { if (open) void query.refetch(); else setOpen(true); }}>Inspect email delivery</Button>
    {open && query.isPending && <p role="status" className="text-sm text-ink-soft">Inspecting delivery metadata…</p>}
    {query.isError && <p role="alert" className="text-xs text-rust">{query.error.message}</p>}
    {query.data && <div className="space-y-1 text-sm text-ink">
      <p>Email rows inspected: {query.data.inspected}</p>
      <p>SMTP acceptance recorded: {query.data.transportAccepted}</p>
      <p>Sent without acceptance evidence: {query.data.sentWithoutEvidence}</p>
      <p>Rows without a valid recipient: {query.data.noValidRecipient}</p>
      <p>Recent orders without email: {query.data.recentOrdersWithoutEmail} of {query.data.recentOrdersInspected}</p>
      <Link to="/outbox" className="inline-block text-pine underline">View notification outbox</Link>
    </div>}
  </CardContent></Card>;
}

export function EmailNotificationsPage() {
  const query = useQuery({ queryKey: ["email-notifications"], queryFn: () => apiGet<EmailNotificationData>("/api/settings/email-notifications") });
  const groups = query.data ? Array.from(new Set(query.data.events.map((event) => event.category))) : [];
  return <PageLayout title="Email Notifications">
    <PageHeader title="Email Notifications" description="Choose which business events send email. Preferences and SMTP readiness are separate." actions={<Link to="/settings#settings-email" className="text-sm text-pine underline">Email configuration</Link>} />
    {query.isPending && <p role="status" className="text-sm text-ink-soft">Loading email preferences…</p>}
    {query.isError && <p role="alert" className="text-sm text-rust">{query.error.message}</p>}
    {query.data && <div className="flex max-w-3xl flex-col gap-6">
      <Card><CardContent className="space-y-2 pt-5">
        <p className="font-medium text-ink">{query.data.configured ? "SMTP configured" : "SMTP not configured"}</p>
        <p className="text-sm text-ink-soft">{query.data.policy}</p>
        <p className="text-xs text-ink-soft">Sent means accepted by the mail server. It does not confirm delivery to the inbox.</p>
      </CardContent></Card>
      <EmailDiagnostics />
      {query.data.schedule && <ReportScheduleForm key={JSON.stringify(query.data.schedule)} schedule={query.data.schedule} />}
      {groups.map((category) => <Card key={category}><CardHeader><CardTitle as="h2">{category}</CardTitle></CardHeader><CardContent className="divide-y divide-line">{query.data!.events.filter((event) => event.category === category).map((event) => <EmailEventToggle key={event.key} event={event} />)}</CardContent></Card>)}
    </div>}
  </PageLayout>;
}
