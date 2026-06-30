import { useState } from "react";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { FilterBar } from "../components/shared/FilterBar";
import { DataTable } from "../components/shared/DataTable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DateInput } from "../components/shared/DateInput";
import { useAudit } from "../hooks/useAudit";

function formatTs(iso: string) {
  return new Date(iso).toLocaleString();
}

interface AuditRow {
  id: number;
  createdAt: string;
  adminId: string | number;
  action: string;
  targetType: string | null;
  targetId: string | number | null;
  details: string | null;
}

const AUDIT_COLUMNS = [
  {
    key: "time",
    header: "Time",
    render: (r: AuditRow) => (
      <span className="text-ink-soft whitespace-nowrap">{formatTs(r.createdAt)}</span>
    ),
  },
  {
    key: "admin",
    header: "Admin",
    render: (r: AuditRow) => (
      <span className="font-mono text-xs text-ink">{r.adminId}</span>
    ),
  },
  {
    key: "action",
    header: "Action",
    render: (r: AuditRow) => <span className="text-ink">{r.action}</span>,
  },
  {
    key: "target",
    header: "Target",
    render: (r: AuditRow) => (
      <span className="text-ink-soft">
        {r.targetType ?? "—"}
        {r.targetId ? ` #${r.targetId}` : ""}
      </span>
    ),
  },
  {
    key: "details",
    header: "Details",
    render: (r: AuditRow) => (
      <span className="text-ink-soft">{r.details ?? "—"}</span>
    ),
  },
];

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
    setPage(n);
    setFilters({ ...filters, page: n });
  }

  return (
    <PageLayout title="Audit Log">
      <PageHeader title="Audit Log" />

      <div className="flex flex-col gap-4">
        <FilterBar onApply={applyFilters}>
          <Input
            placeholder="Action"
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className="w-36"
          />
          <Input
            placeholder="Target type"
            value={targetType}
            onChange={(e) => setTargetType(e.target.value)}
            className="w-36"
          />
          <Input
            placeholder="Admin ID"
            value={adminId}
            onChange={(e) => setAdminId(e.target.value)}
            className="w-32"
          />
          <DateInput
            value={since}
            onChange={(e) => setSince(e.target.value)}
            className="w-36"
          />
          <DateInput
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            className="w-36"
          />
        </FilterBar>

        {isError && <p className="text-sm text-rust">Failed to load audit log.</p>}

        <DataTable
          columns={AUDIT_COLUMNS}
          data={data?.rows ?? []}
          isLoading={isLoading && !data}
          keyExtractor={(r) => r.id}
        />

        {data && (data.hasNext || page > 1) && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => goPage(page - 1)}
            >
              ← Prev
            </Button>
            <span className="text-sm text-ink-soft">Page {page}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={!data.hasNext}
              onClick={() => goPage(page + 1)}
            >
              Next →
            </Button>
          </div>
        )}
      </div>
    </PageLayout>
  );
}
