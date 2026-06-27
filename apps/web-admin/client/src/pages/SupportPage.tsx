import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { PageLayout } from "../components/shared/PageLayout";

interface Ticket {
  id: number;
  subject: string;
  status: string;
  createdAt: string;
  user?: { fullName: string | null; username: string | null };
}

function useTickets() {
  return useQuery<{ tickets: Ticket[] }>({
    queryKey: ["support"],
    queryFn: async () => {
      const res = await fetch("/api/support");
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<{ tickets: Ticket[] }>;
    },
  });
}

export function SupportPage() {
  const navigate = useNavigate();
  const { data, isError } = useTickets();

  if (isError) return <PageLayout title="Support"><p style={{ color: "red" }}>Failed to load tickets.</p></PageLayout>;

  return (
    <PageLayout title="Support">
      {!data ? (
        <p>Loading…</p>
      ) : data.tickets.length === 0 ? (
        <p>No open tickets.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#f5f5f5" }}>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>#</th>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>Subject</th>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>Customer</th>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>Status</th>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>Date</th>
            </tr>
          </thead>
          <tbody>
            {data.tickets.map(t => (
              <tr
                key={t.id}
                style={{ borderTop: "1px solid #eee", cursor: "pointer" }}
                onClick={() => navigate(`/support/${t.id}`)}
              >
                <td style={{ padding: "6px 8px", fontFamily: "monospace" }}>{t.id}</td>
                <td style={{ padding: "6px 8px" }}>{t.subject}</td>
                <td style={{ padding: "6px 8px" }}>{t.user?.fullName ?? t.user?.username ?? "—"}</td>
                <td style={{ padding: "6px 8px" }}>{t.status}</td>
                <td style={{ padding: "6px 8px", fontSize: 12 }}>{new Date(t.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </PageLayout>
  );
}
