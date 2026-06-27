import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { PageLayout } from "../components/shared/PageLayout";

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
  const { data, isError } = useUsers(q);

  if (isError) return <PageLayout title="Customers"><p style={{ color: "red" }}>Failed to load customers.</p></PageLayout>;

  return (
    <PageLayout title="Customers">
      <form onSubmit={e => { e.preventDefault(); setQ(input.trim()); }} style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Search by name, username, Telegram ID…"
          style={{ flex: 1, padding: "6px 10px", border: "1px solid #ccc", borderRadius: 4 }}
        />
        <button type="submit" style={{ padding: "6px 16px" }}>Search</button>
        {q && <button type="button" onClick={() => { setInput(""); setQ(""); }} style={{ padding: "6px 12px" }}>Clear</button>}
      </form>

      {!data ? (
        <p>Loading…</p>
      ) : data.users.length === 0 ? (
        <p>No customers found.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#f5f5f5" }}>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>Name</th>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>Username</th>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>Telegram ID</th>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>Role</th>
              <th style={{ textAlign: "center", padding: "6px 8px" }}>Banned</th>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>Joined</th>
            </tr>
          </thead>
          <tbody>
            {data.users.map(u => (
              <tr
                key={u.id}
                style={{ borderTop: "1px solid #eee", cursor: "pointer", background: u.banned ? "#fff5f5" : undefined }}
                onClick={() => navigate(`/users/${u.id}`)}
              >
                <td style={{ padding: "6px 8px" }}>{u.fullName ?? "—"}</td>
                <td style={{ padding: "6px 8px" }}>{u.username ? `@${u.username}` : "—"}</td>
                <td style={{ padding: "6px 8px", fontFamily: "monospace" }}>{u.telegramId}</td>
                <td style={{ padding: "6px 8px" }}>{u.role}</td>
                <td style={{ padding: "6px 8px", textAlign: "center" }}>{u.banned ? "Yes" : "—"}</td>
                <td style={{ padding: "6px 8px", fontSize: 12 }}>{new Date(u.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </PageLayout>
  );
}
