import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "../components/shared/PageLayout";
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

  if (isError) return <PageLayout title="Ticket"><p style={{ color: "red" }}>Failed to load ticket.</p></PageLayout>;
  if (!data) return <PageLayout title="Ticket"><p>Loading…</p></PageLayout>;

  const { ticket, messages, user } = data;

  return (
    <PageLayout title={`Ticket #${ticket.id}`}>
      <button onClick={() => navigate("/support")} style={{ marginBottom: 16, background: "none", border: "1px solid #ccc", borderRadius: 4, padding: "4px 12px", cursor: "pointer" }}>
        ← Back to Support
      </button>

      <section style={{ marginBottom: 16 }}>
        <p><strong>Subject:</strong> {ticket.subject}</p>
        <p><strong>Status:</strong> {ticket.status}</p>
        <p><strong>Customer:</strong> {user?.fullName ?? user?.username ?? "Unknown"}</p>
      </section>

      <section style={{ marginBottom: 20 }}>
        {messages.map(m => (
          <div
            key={m.id}
            style={{
              padding: "10px 14px",
              marginBottom: 8,
              borderRadius: 6,
              background: m.senderType === "ADMIN" ? "#e8f4fd" : "#f9f9f9",
              borderLeft: `3px solid ${m.senderType === "ADMIN" ? "#0078d4" : "#ccc"}`,
            }}
          >
            <div style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>
              {m.senderType === "ADMIN" ? "Admin" : "Customer"} — {new Date(m.createdAt).toLocaleString()}
            </div>
            <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
          </div>
        ))}
      </section>

      {ticket.status !== "CLOSED" && (
        <>
          <section style={{ marginBottom: 16 }}>
            {replyError && <p style={{ color: "red", margin: "0 0 8px" }}>{replyError}</p>}
            <textarea
              value={reply}
              onChange={e => setReply(e.target.value)}
              placeholder="Write a reply…"
              rows={4}
              style={{ width: "100%", padding: "6px 10px", marginBottom: 8, boxSizing: "border-box" }}
            />
            <button onClick={() => sendReply.mutate()} disabled={!reply || sendReply.isPending} style={{ padding: "6px 16px" }}>
              Save Reply
            </button>
          </section>
          <button
            onClick={() => { if (confirm("Close this ticket?")) close.mutate(); }}
            style={{ padding: "6px 14px", background: "#dc3545", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer" }}
          >
            Close Ticket
          </button>
        </>
      )}
    </PageLayout>
  );
}
