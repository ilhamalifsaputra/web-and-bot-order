import { useState } from "react";
import { PageLayout } from "../components/shared/PageLayout";
import { EmptyState } from "../components/shared/EmptyState";
import { useAudit } from "../hooks/useAudit";

function formatTs(iso: string) {
  return new Date(iso).toLocaleString();
}

export function AuditPage() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState("");
  const [targetType, setTargetType] = useState("");
  const [adminId, setAdminId] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [filters, setFilters] = useState({ page: 1, action: "", targetType: "", adminId: "", since: "", until: "" });

  const { data, isLoading, isError } = useAudit(filters);

  function applyFilters() {
    setPage(1);
    setFilters({ page: 1, action, targetType, adminId, since, until });
  }

  function goPage(n: number) {
    const next = { ...filters, page: n };
    setPage(n);
    setFilters(next);
  }

  return (
    <PageLayout title="Audit Log">
      <div className="flex flex-col gap-4">
        {/* Filter bar */}
        <div className="flex flex-wrap gap-2">
          <input
            className="rounded border border-line bg-card px-3 py-1.5 text-sm text-ink placeholder:text-ink-faint"
            placeholder="Action"
            value={action}
            onChange={(e) => setAction(e.target.value)}
          />
          <input
            className="rounded border border-line bg-card px-3 py-1.5 text-sm text-ink placeholder:text-ink-faint"
            placeholder="Target type"
            value={targetType}
            onChange={(e) => setTargetType(e.target.value)}
          />
          <input
            className="rounded border border-line bg-card px-3 py-1.5 text-sm text-ink placeholder:text-ink-faint"
            placeholder="Admin ID"
            value={adminId}
            onChange={(e) => setAdminId(e.target.value)}
          />
          <input
            type="date"
            className="rounded border border-line bg-card px-3 py-1.5 text-sm text-ink"
            value={since}
            onChange={(e) => setSince(e.target.value)}
          />
          <input
            type="date"
            className="rounded border border-line bg-card px-3 py-1.5 text-sm text-ink"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
          />
          <button
            onClick={applyFilters}
            className="rounded bg-pine px-3 py-1.5 text-sm font-medium text-white hover:bg-pine/90"
          >
            Filter
          </button>
        </div>

        {isLoading && <p className="text-sm text-ink-soft">Loading…</p>}
        {isError && <p className="text-sm text-rust">Failed to load audit log.</p>}

        {data && data.rows.length === 0 && <EmptyState message="No audit entries found." />}

        {data && data.rows.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-line bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-ink-soft">
                  <th className="px-4 py-3 font-medium">Time</th>
                  <th className="px-4 py-3 font-medium">Admin</th>
                  <th className="px-4 py-3 font-medium">Action</th>
                  <th className="px-4 py-3 font-medium">Target</th>
                  <th className="px-4 py-3 font-medium">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.rows.map((row) => (
                  <tr key={row.id} className="hover:bg-sand/40">
                    <td className="whitespace-nowrap px-4 py-2 text-ink-soft">{formatTs(row.createdAt)}</td>
                    <td className="px-4 py-2 font-mono text-xs text-ink">{row.adminId}</td>
                    <td className="px-4 py-2 text-ink">{row.action}</td>
                    <td className="px-4 py-2 text-ink-soft">
                      {row.targetType ?? "—"}
                      {row.targetId ? ` #${row.targetId}` : ""}
                    </td>
                    <td className="px-4 py-2 text-ink-soft">{row.details ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {data && (data.hasNext || page > 1) && (
          <div className="flex items-center gap-2">
            <button
              disabled={page <= 1}
              onClick={() => goPage(page - 1)}
              className="rounded border border-line px-3 py-1.5 text-sm text-ink disabled:opacity-40"
            >
              ← Prev
            </button>
            <span className="text-sm text-ink-soft">Page {page}</span>
            <button
              disabled={!data.hasNext}
              onClick={() => goPage(page + 1)}
              className="rounded border border-line px-3 py-1.5 text-sm text-ink disabled:opacity-40"
            >
              Next →
            </button>
          </div>
        )}
      </div>
    </PageLayout>
  );
}
