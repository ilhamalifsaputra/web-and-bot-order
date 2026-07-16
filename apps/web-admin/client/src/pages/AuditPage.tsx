import { useMemo, useState } from "react";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { FilterBar } from "../components/shared/FilterBar";
import { DataTable } from "../components/shared/DataTable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DateInput } from "../components/shared/DateInput";
import { useAudit } from "../hooks/useAudit";
import { useAdmins } from "../hooks/useAdmins";

interface AuditRow {
  id: number;
  createdAt: string;
  createdAtDisplay: string | null;
  adminId: string | number;
  action: string;
  targetType: string | null;
  targetId: string | number | null;
  details: string | null;
}

/**
 * F-005: the raw backend action code (e.g. `denomination_create`) is
 * redundant next to the Details column's already-readable sentence, but
 * dropping the column loses a stable, filterable-by-eye category for
 * scanning (and the page's "Action" filter input already searches this
 * exact code). Chose to keep the column but map known codes to a short
 * human label instead — every code currently emitted by
 * `logAdminAction(...)` across `apps/web-admin/src/routes/**` is listed
 * here (grepped for `action: "..."` call sites). Unknown/future codes fall
 * back to a generic humanizer (underscores → spaces, title case) instead of
 * showing blank or crashing, per the task's fallback requirement. The raw
 * code is still available via a `title` tooltip, mirroring the Admin
 * column's id-tooltip pattern from F-004.
 */
const ACTION_LABELS: Record<string, string> = {
  web_login_failed: "Login failed",
  web_password_reset: "Password reset",
  web_password_change: "Password changed",
  web_admin_set_role: "Admin role changed",
  web_admin_add: "Admin added",
  web_admin_remove: "Admin removed",
  web_admin_force_logout: "Admin force-logged-out",
  web_setup_completed: "Setup completed",
  branding_banner_clear: "Banner cleared",
  setting_set: "Setting changed",
  setting_clear: "Setting cleared",
  payment_method_toggle: "Payment method toggled",
  broadcast_enqueue: "Broadcast queued",
  broadcast_cancel: "Broadcast cancelled",
  catalog_product_create: "Product created",
  catalog_import: "Catalog imported",
  category_create: "Category created",
  category_update: "Category updated",
  category_toggle: "Category toggled",
  denomination_create: "Denomination created",
  denomination_update: "Denomination updated",
  denomination_delete: "Denomination deleted",
  denomination_active_toggle: "Denomination toggled",
  product_update: "Product updated",
  product_active_toggle: "Product toggled",
  product_bulk_active: "Products bulk-toggled",
  product_delete: "Product deleted",
  bulk_pricing_set: "Bulk pricing set",
  bulk_pricing_delete: "Bulk pricing removed",
  underpaid_deliver: "Underpaid order delivered",
  underpaid_refund: "Underpaid order refunded",
  underpaid_cancel: "Underpaid order cancelled",
  tx_manual_match: "Transaction manually matched",
  tx_credit_balance: "Transaction credited to balance",
  tx_dismiss: "Transaction dismissed",
  outbox_retry: "Outbox message retried",
  voucher_create: "Voucher created",
  voucher_toggle: "Voucher toggled",
  voucher_delete: "Voucher deleted",
  ticket_reply: "Support ticket replied",
  ticket_close: "Support ticket closed",
  ticket_assign: "Support ticket assigned",
  user_set_role: "User role changed",
  wallet_adjust: "Wallet adjusted",
  approve_order: "Order approved",
  reject_order: "Order rejected",
  order_resend_credentials: "Order credentials resent",
  order_credit_balance: "Order credited to balance",
  stock_upload: "Stock uploaded",
  stock_bulk_dead: "Stock bulk marked dead",
  stock_bulk_delete: "Stock bulk deleted",
  stock_mark_dead: "Stock marked dead",
  stock_edit_note: "Stock note edited",
  stock_download: "Stock downloaded",
};

/** Fallback for any action code not in `ACTION_LABELS` above: turn
 * `some_new_action` into "Some New Action" rather than showing the raw
 * code, a blank cell, or throwing. */
function humanizeActionCode(action: string): string {
  return action
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? humanizeActionCode(action);
}

/**
 * F-004: the raw `adminId` on an audit row is the acting admin's internal
 * `User.id` (see `logAdminAction(prisma, { adminId: req.admin!.userId, ... })`
 * in `apps/web-admin/src/routes/api/*.ts`) — the same id `GET /api/admins`
 * returns as each row's `id` field. Resolving it client-side this way needs
 * no backend change. `GET /api/admins` is super-admin only, so a non-super
 * admin viewing this page simply won't get a name map (react-query surfaces
 * that as an error, not a thrown exception) and every row falls back to
 * `Admin #<id>` — same information as before, just labeled.
 */
function useAdminNameMap(): Map<number, string> {
  const { data } = useAdmins();
  return useMemo(() => {
    const map = new Map<number, string>();
    for (const admin of data?.admins ?? []) {
      if (admin.id != null) {
        map.set(admin.id, admin.name ?? `Telegram ${admin.telegramId}`);
      }
    }
    return map;
  }, [data]);
}

function buildAuditColumns(adminNames: Map<number, string>) {
  return [
    {
      key: "time",
      header: "Time",
      render: (r: AuditRow) => (
        <span className="text-ink-soft whitespace-nowrap">{r.createdAtDisplay ?? "—"}</span>
      ),
    },
    {
      key: "admin",
      header: "Admin",
      render: (r: AuditRow) => {
        const id = typeof r.adminId === "string" ? Number(r.adminId) : r.adminId;
        const name = Number.isFinite(id) ? adminNames.get(id) : undefined;
        return (
          <span className="text-sm text-ink" title={`Admin ID ${r.adminId}`}>
            {name ?? `Admin #${r.adminId}`}
          </span>
        );
      },
    },
    {
      key: "action",
      header: "Action",
      render: (r: AuditRow) => (
        <span className="text-ink" title={r.action}>
          {actionLabel(r.action)}
        </span>
      ),
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
  const adminNames = useAdminNameMap();
  const auditColumns = useMemo(() => buildAuditColumns(adminNames), [adminNames]);

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
          columns={auditColumns}
          data={data?.rows ?? []}
          isLoading={isLoading && !data}
          keyExtractor={(r) => r.id}
          empty={<div className="py-8 text-center text-sm text-ink-soft">No audit entries found.</div>}
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
