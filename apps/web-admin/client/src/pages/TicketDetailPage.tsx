import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { StatusBadge } from "../components/shared/StatusBadge";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { apiPost } from "../api/client";

interface TicketDetail {
  ticket: { id: number; subject: string; status: string; createdAt: string };
  messages: { id: number; content: string; senderType: string; createdAt: string }[];
  user: { id: number; fullName: string | null; username: string | null } | null;
}

function useTicket(ticketId: string) {
  return useQuery<TicketDetail>({
    queryKey: ["ticket", ticketId],
    queryFn: async () => {
      const res = await fetch(`/api/support/${ticketId}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<TicketDetail>;
    },
  });
}

export function TicketDetailPage() {
  const { ticketId } = useParams<{ ticketId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, isError } = useTicket(ticketId ?? "");
  const [reply, setReply] = useState("");
  const [replyError, setReplyError] = useState<string | null>(null);

  const sendReply = useMutation({
    mutationFn: () => apiPost(`/api/support/${ticketId}/reply`, { content: reply }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["ticket", ticketId] });
      setReply("");
      setReplyError(null);
    },
    onError: (e: Error) => setReplyError(e.message),
  });

  const close = useMutation({
    mutationFn: () => apiPost(`/api/support/${ticketId}/close`, {}),
    onSuccess: () => { navigate("/support"); },
    onError: (e: Error) => alert(e.message),
  });

  if (isError) return <PageLayout title="Ticket"><p className="text-sm text-rust">Failed to load ticket.</p></PageLayout>;
  if (!data) return <PageLayout title="Ticket"><p>Loading…</p></PageLayout>;

  const { ticket, messages, user } = data;

  return (
    <PageLayout title={`Ticket #${ticket.id}`}>
      <PageHeader
        title={`Ticket #${ticket.id}: ${ticket.subject}`}
        breadcrumb={[{ label: "Support", href: "/support" }]}
        actions={<Button variant="outline" size="sm" onClick={() => navigate("/support")}>← Back</Button>}
      />

      {/* Ticket meta */}
      <div className="mb-4 flex gap-3 items-center text-sm">
        <StatusBadge status={ticket.status} />
        <span className="text-ink-soft">Customer: <span className="text-ink">{user?.fullName ?? user?.username ?? "Unknown"}</span></span>
      </div>

      {/* Message thread */}
      <div className="flex flex-col gap-3 mb-6">
        {messages.map(m => (
          <div
            key={m.id}
            className={`rounded-lg border-l-2 px-4 py-3 ${
              m.senderType === "ADMIN"
                ? "border-pine bg-pine-tint"
                : "border-line bg-sand"
            }`}
          >
            <div className="mb-1 text-xs text-ink-soft">
              {m.senderType === "ADMIN" ? "Admin" : "Customer"} — {new Date(m.createdAt).toLocaleString()}
            </div>
            <div className="text-sm text-ink whitespace-pre-wrap">{m.content}</div>
          </div>
        ))}
      </div>

      {/* Reply + close */}
      {ticket.status !== "CLOSED" && (
        <Card>
          <CardHeader><CardTitle>Reply</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-3">
            {replyError && <p className="text-sm text-rust">{replyError}</p>}
            <Textarea
              value={reply}
              onChange={e => setReply(e.target.value)}
              placeholder="Write a reply…"
              rows={4}
            />
            <div className="flex gap-2">
              <Button onClick={() => sendReply.mutate()} disabled={!reply || sendReply.isPending}>
                {sendReply.isPending ? "Saving…" : "Send Reply"}
              </Button>
              <ConfirmDialog
                trigger={<Button variant="destructive">Close Ticket</Button>}
                title="Close this ticket?"
                description="The ticket will be marked as closed and no further replies can be added."
                confirmLabel="Close"
                onConfirm={() => close.mutate()}
              />
            </div>
          </CardContent>
        </Card>
      )}
    </PageLayout>
  );
}
