import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { FilterBar } from "../components/shared/FilterBar";
import { SearchBar } from "../components/shared/SearchBar";
import { DataTable } from "../components/shared/DataTable";
import { EmptyState } from "../components/shared/EmptyState";
import { OrderStatusBadge } from "../components/shared/OrderStatusBadge";
import { PaymentMethodBadge } from "../components/shared/PaymentMethodBadge";
import { Pagination } from "../components/shared/Pagination";
import { OrdersKpiRow } from "./orders/OrdersKpiRow";
import { OrderStatusTabs, statusesForTab, type StatusTabKey } from "./orders/OrderStatusTabs";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { DateInput } from "../components/shared/DateInput";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { ShoppingCart, MoreVertical, Eye, Check, Send, RefreshCw, XCircle } from "lucide-react";
import { formatCurrencyParts } from "../components/shared/CurrencyAmount";
import { useOrdersKpis } from "../hooks/useOrdersKpis";
import { orderStatusLabel } from "../lib/orderStatus";
import { PAYMENT_METHOD_LABELS, paymentMethodLabel } from "../lib/paymentMethod";
import { apiPost } from "../api/client";
import { describeError } from "../lib/errorMessages";

interface OrderItemRow {
  id: number;
  quantity: number;
  product: { id: number; name: string };
}

interface OrderEligibility {
  isDelivered: boolean;
  canAct: boolean;
  canCredit: boolean;
  canFulfill: boolean;
  canReject: boolean;
  canResend: boolean;
}

interface OrderRow {
  id: number;
  orderCode: string;
  status: string;
  currency: string;
  totalAmount: string;
  paymentMethod: string;
  createdAt: string;
  createdAtDisplay: string | null;
  user: { id: number; fullName: string | null; username: string | null; telegramId: string | null } | null;
  items: OrderItemRow[];
  eligibility: OrderEligibility;
}

interface OrdersData {
  orders: OrderRow[];
  total: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
  statuses: string[];
}

interface BulkActionResult {
  succeeded: number[];
  failed: { id: number; error: string }[];
}

interface Filters {
  status: string;
  paymentMethod: string;
  q: string;
  since: string;
  until: string;
  page: number;
  pageSize: number;
}

/** Orders that can never be cancelled again (already voided/refunded) — the
 *  row/bulk "Cancel Order" eligibility gate, mirroring the backend's own
 *  TERMINAL_NON_DELIVERED_STATUSES check in bulk-action's cancel branch. */
const TERMINAL_STATUSES = new Set(["CANCELLED", "REJECTED", "REFUNDED"]);

function canCancelOrder(row: OrderRow): boolean {
  return !row.eligibility.isDelivered && !TERMINAL_STATUSES.has(row.status);
}

function useOrders(filters: Filters) {
  return useQuery<OrdersData>({
    queryKey: ["orders", filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.status) params.set("status", filters.status);
      if (filters.paymentMethod) params.set("paymentMethod", filters.paymentMethod);
      if (filters.q) params.set("q", filters.q);
      if (filters.since) params.set("since", filters.since);
      if (filters.until) params.set("until", filters.until);
      if (filters.page > 1) params.set("page", String(filters.page));
      if (filters.pageSize !== 20) params.set("pageSize", String(filters.pageSize));
      const res = await fetch(`/api/orders?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<OrdersData>;
    },
  });
}

const PAYMENT_METHOD_VALUES = Object.keys(PAYMENT_METHOD_LABELS);

export function OrdersPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialStatus = searchParams.get("status") ?? "";
  // Lets other pages (e.g. Support's "Order History" row action) deep-link
  // straight into a pre-filtered Orders search via /orders?q=<term>.
  const initialQ = searchParams.get("q") ?? "";

  // `draft.status` is the granular single-status Select (still useful for
  // narrowing WITHIN a tab, e.g. tab=Awaiting + Select=UNDERPAID). When it
  // has a value it takes precedence over the active tab's status set; when
  // cleared, the tab's set applies again. Tabs/pagination act immediately;
  // search/paymentMethod/date-range/status-select stay on the existing
  // Apply-button-commit pattern.
  const [activeTab, setActiveTab] = useState<StatusTabKey>("all");
  const [draft, setDraft] = useState({ status: initialStatus, paymentMethod: "", q: initialQ, since: "", until: "" });
  const [filters, setFilters] = useState<Filters>({
    status: initialStatus,
    paymentMethod: "",
    q: initialQ,
    since: "",
    until: "",
    page: 1,
    pageSize: 20,
  });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [cancelTarget, setCancelTarget] = useState<{ ids: number[] } | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  const { data, isLoading, isError, refetch } = useOrders(filters);
  const { data: kpis } = useOrdersKpis();

  // A stale selection surviving a new page/filter result set would let a
  // bulk action silently apply to rows no longer on screen — clear it
  // whenever the query changes.
  useEffect(() => {
    setSelected(new Set());
  }, [filters]);

  function invalidateAll() {
    void queryClient.invalidateQueries({ queryKey: ["orders"] });
  }

  const deliverMutation = useMutation({
    mutationFn: (orderId: number) => apiPost(`/api/orders/${orderId}/approve`, {}),
    onSuccess: () => {
      invalidateAll();
      toast.success("Order approved and delivered.");
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const resendMutation = useMutation({
    mutationFn: (orderId: number) => apiPost(`/api/orders/${orderId}/resend`, {}),
    onSuccess: () => toast.success("Delivery credentials resent."),
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  const bulkMutation = useMutation({
    mutationFn: (vars: { ids: number[]; action: "deliver" | "resend" }) =>
      apiPost<BulkActionResult>("/api/orders/bulk-action", vars),
    onSuccess: (result) => {
      invalidateAll();
      setSelected(new Set());
      toast.success(`${result.succeeded.length} succeeded, ${result.failed.length} failed.`);
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  // Row cancel (single id) uses the dedicated /cancel route so the audit log
  // reads "cancel_order"; a multi-id selection goes through /bulk-action
  // (logs one "order_bulk_cancel" summary row instead) — same Dialog drives
  // both, the response is normalized to the bulk shape either way so the
  // toast copy doesn't need to branch.
  const cancelMutation = useMutation({
    mutationFn: async (vars: { ids: number[]; reason: string }): Promise<BulkActionResult> => {
      if (vars.ids.length === 1) {
        await apiPost(`/api/orders/${vars.ids[0]}/cancel`, { reason: vars.reason });
        return { succeeded: vars.ids, failed: [] };
      }
      return apiPost<BulkActionResult>("/api/orders/bulk-action", {
        ids: vars.ids,
        action: "cancel",
        reason: vars.reason,
      });
    },
    onSuccess: (result) => {
      invalidateAll();
      setSelected(new Set());
      setCancelTarget(null);
      setCancelReason("");
      toast.success(
        result.failed.length > 0
          ? `${result.succeeded.length} succeeded, ${result.failed.length} failed.`
          : result.succeeded.length > 1
            ? `${result.succeeded.length} orders cancelled.`
            : "Order cancelled.",
      );
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  if (isError) {
    return (
      <PageLayout title="Orders">
        <p className="text-rust">Failed to load orders.</p>
      </PageLayout>
    );
  }

  const statuses = data?.statuses ?? [];
  const pageOrders = data?.orders ?? [];

  function selectTab(tab: StatusTabKey) {
    setActiveTab(tab);
    setDraft((d) => ({ ...d, status: "" })); // clear the granular override so the tab's bucket is what's shown
    const status = statusesForTab(tab);
    setFilters((f) => ({ ...f, status, page: 1 }));
    setSearchParams(status ? { status } : {});
  }

  function applyFilters() {
    const status = draft.status || statusesForTab(activeTab);
    setFilters((f) => ({
      ...f,
      status,
      paymentMethod: draft.paymentMethod,
      q: draft.q,
      since: draft.since,
      until: draft.until,
      page: 1,
    }));
    setSearchParams(status ? { status } : {});
  }

  function clearFilters() {
    setActiveTab("all");
    setDraft({ status: "", paymentMethod: "", q: "", since: "", until: "" });
    setFilters({ status: "", paymentMethod: "", q: "", since: "", until: "", page: 1, pageSize: 20 });
    setSearchParams({});
  }

  const hasActiveFilter = Boolean(filters.status || filters.paymentMethod || filters.q || filters.since || filters.until);

  const exportParams = new URLSearchParams();
  if (filters.status) exportParams.set("status", filters.status);
  if (filters.paymentMethod) exportParams.set("paymentMethod", filters.paymentMethod);
  if (filters.q) exportParams.set("q", filters.q);
  if (filters.since) exportParams.set("since", filters.since);
  if (filters.until) exportParams.set("until", filters.until);

  function toggleSelected(id: number) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  const allOnPageSelected = pageOrders.length > 0 && pageOrders.every((o) => selected.has(o.id));
  function toggleSelectAllOnPage() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        pageOrders.forEach((o) => next.delete(o.id));
      } else {
        pageOrders.forEach((o) => next.add(o.id));
      }
      return next;
    });
  }

  function eligibleSelectedIds(predicate: (row: OrderRow) => boolean): number[] {
    return pageOrders.filter((o) => selected.has(o.id) && predicate(o)).map((o) => o.id);
  }

  function runBulk(action: "deliver" | "resend", predicate: (row: OrderRow) => boolean, ineligibleMessage: string) {
    const ids = eligibleSelectedIds(predicate);
    if (ids.length === 0) {
      toast.error(ineligibleMessage);
      return;
    }
    bulkMutation.mutate({ ids, action });
  }

  function openCancelDialog(ids: number[]) {
    setCancelTarget({ ids });
    setCancelReason("");
  }

  function confirmCancel() {
    if (!cancelTarget) return;
    if (!cancelReason.trim()) {
      toast.error("A cancellation reason is required.");
      return;
    }
    cancelMutation.mutate({ ids: cancelTarget.ids, reason: cancelReason.trim() });
  }

  return (
    <PageLayout title="Orders">
      <PageHeader
        title="Orders"
        description="Manage customer purchases, payments, deliveries and fulfillment."
        actions={
          <a href={`/api/orders/export?${exportParams.toString()}`}>
            <Button variant="outline" size="sm">Export CSV</Button>
          </a>
        }
      />

      {kpis && (
        <p className="mb-4 text-xs text-ink-soft">
          {kpis.totalOrders} Orders · {kpis.awaitingFulfillment} Awaiting Fulfillment ·{" "}
          {kpis.processing} Processing · {kpis.delivered} Delivered
        </p>
      )}

      <OrdersKpiRow />

      <OrderStatusTabs active={activeTab} onChange={selectTab} />

      <FilterBar onApply={applyFilters} onClear={clearFilters} className="mb-4">
        <SearchBar
          value={draft.q}
          onChange={(v) => setDraft((f) => ({ ...f, q: v }))}
          onSearch={applyFilters}
          placeholder="Search order code, customer or product..."
          className="w-full sm:w-[420px]"
        />

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Status</label>
          <Select
            value={draft.status || "_all_"}
            onValueChange={(v) => setDraft((f) => ({ ...f, status: v === "_all_" ? "" : v }))}
          >
            <SelectTrigger className="w-40">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="_all_">All</SelectItem>
              {statuses.map((s) => (
                <SelectItem key={s} value={s}>
                  {orderStatusLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Payment Method</label>
          <Select
            value={draft.paymentMethod || "_all_"}
            onValueChange={(v) => setDraft((f) => ({ ...f, paymentMethod: v === "_all_" ? "" : v }))}
          >
            <SelectTrigger className="w-40">
              <SelectValue placeholder="All methods" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="_all_">All methods</SelectItem>
              {PAYMENT_METHOD_VALUES.map((m) => (
                <SelectItem key={m} value={m}>
                  {paymentMethodLabel(m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">From</label>
          <DateInput
            value={draft.since}
            onChange={(e) => setDraft((f) => ({ ...f, since: e.target.value }))}
            className="w-36"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">To</label>
          <DateInput
            value={draft.until}
            onChange={(e) => setDraft((f) => ({ ...f, until: e.target.value }))}
            className="w-36"
          />
        </div>
      </FilterBar>

      {selected.size > 0 && (
        <div className="sticky bottom-4 z-10 mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-card px-3 py-2 text-sm shadow-lift transition-all duration-150">
          <span className="text-ink-soft">{selected.size} selected</span>
          <Button
            size="sm"
            variant="outline"
            disabled={bulkMutation.isPending}
            onClick={() => runBulk("deliver", (o) => o.eligibility.canAct, "None of the selected orders can be delivered.")}
          >
            Mark Delivered
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={bulkMutation.isPending}
            onClick={() => runBulk("resend", (o) => o.eligibility.canResend, "None of the selected orders can be resent.")}
          >
            Resend
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={cancelMutation.isPending}
            onClick={() => {
              const ids = eligibleSelectedIds(canCancelOrder);
              if (ids.length === 0) {
                toast.error("None of the selected orders can be cancelled.");
                return;
              }
              openCancelDialog(ids);
            }}
          >
            Cancel
          </Button>
          <a href={`/api/orders/export?ids=${Array.from(selected).join(",")}`}>
            <Button size="sm" variant="ghost">Export</Button>
          </a>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      <DataTable
        stickyHeader
        columns={[
          {
            key: "select",
            header: (
              <Checkbox
                checked={allOnPageSelected}
                onCheckedChange={toggleSelectAllOnPage}
                aria-label="Select all orders on this page"
              />
            ),
            render: (row) => (
              <Checkbox
                checked={selected.has(row.id)}
                onCheckedChange={() => toggleSelected(row.id)}
                onClick={(e) => e.stopPropagation()}
                aria-label={`Select order ${row.orderCode}`}
              />
            ),
          },
          {
            key: "code",
            header: "Order Code",
            render: (row) => (
              <span className="font-mono text-sm font-semibold text-ink">{row.orderCode}</span>
            ),
          },
          {
            key: "customer",
            header: "Customer",
            render: (row) => (
              <div>
                <div className="text-sm text-ink">{row.user?.fullName ?? row.user?.username ?? "—"}</div>
                <div className="text-xs text-ink-soft">
                  {row.user?.telegramId ? `Telegram ${row.user.telegramId}` : row.user ? "Registered Customer" : "—"}
                </div>
              </div>
            ),
          },
          {
            key: "products",
            header: "Product Count",
            render: (row) => {
              if (row.items.length === 0) return <span className="text-sm text-ink-soft">—</span>;
              const first = row.items[0]!;
              const extra = row.items.length - 1;
              return (
                <span className="text-sm text-ink">
                  {first.product.name}
                  {extra > 0 && <span className="text-ink-soft"> +{extra}</span>}
                </span>
              );
            },
          },
          {
            key: "paymentMethod",
            header: "Payment Method",
            render: (row) => <PaymentMethodBadge method={row.paymentMethod} />,
          },
          {
            key: "status",
            header: "Status",
            render: (row) => <OrderStatusBadge status={row.status} />,
          },
          {
            key: "total",
            header: "Total",
            render: (row) => {
              const { amount, suffix } = formatCurrencyParts(row.totalAmount, row.currency as "IDR" | "USDT" | "USD");
              return (
                <span className="font-mono text-sm">
                  <span className="font-semibold text-ink">{amount}</span>
                  {suffix && <span className="ml-1 text-xs text-ink-soft">{suffix}</span>}
                </span>
              );
            },
          },
          {
            key: "date",
            header: "Order Date",
            render: (row) => (
              <span className="text-xs text-ink-soft">{row.createdAtDisplay ?? "—"}</span>
            ),
          },
          {
            key: "actions",
            header: "",
            render: (row) => (
              <div onClick={(e) => e.stopPropagation()}>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${row.orderCode}`}>
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => navigate(`/orders/${row.id}`)}>
                      <Eye className="h-4 w-4" />
                      View Order
                    </DropdownMenuItem>
                    {row.eligibility.canAct && (
                      <DropdownMenuItem onSelect={() => deliverMutation.mutate(row.id)}>
                        <Check className="h-4 w-4" />
                        Deliver
                      </DropdownMenuItem>
                    )}
                    {row.eligibility.canFulfill && (
                      <DropdownMenuItem onSelect={() => navigate(`/orders/${row.id}`)}>
                        <Send className="h-4 w-4" />
                        Fulfill Manually
                      </DropdownMenuItem>
                    )}
                    {row.eligibility.canResend && (
                      <DropdownMenuItem onSelect={() => resendMutation.mutate(row.id)}>
                        <RefreshCw className="h-4 w-4" />
                        Resend Delivery
                      </DropdownMenuItem>
                    )}
                    {canCancelOrder(row) && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={(e) => {
                            e.preventDefault();
                            openCancelDialog([row.id]);
                          }}
                        >
                          <XCircle className="h-4 w-4" />
                          Cancel Order
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ),
          },
        ]}
        data={pageOrders}
        isLoading={isLoading}
        keyExtractor={(row) => row.id}
        onRowClick={(row) => navigate(`/orders/${row.id}`)}
        empty={
          <EmptyState
            icon={ShoppingCart}
            title="No orders found."
            description="Orders will appear here once customers start purchasing."
            action={{ label: "Refresh", onClick: () => void refetch() }}
            secondaryAction={hasActiveFilter ? { label: "Clear Filters", onClick: clearFilters } : undefined}
          />
        }
      />

      {data && (
        <div className="mt-4">
          <Pagination
            page={filters.page}
            pageSize={filters.pageSize}
            total={data.total}
            onPageChange={(page) => setFilters((f) => ({ ...f, page }))}
            onPageSizeChange={(pageSize) => setFilters((f) => ({ ...f, pageSize, page: 1 }))}
          />
        </div>
      )}

      {cancelTarget && (
        <Dialog open onOpenChange={(open) => { if (!open) setCancelTarget(null); }}>
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>
                {cancelTarget.ids.length > 1 ? `Cancel ${cancelTarget.ids.length} orders?` : "Cancel this order?"}
              </DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <p className="text-sm text-ink-soft">
                Releases any wallet-credit/stock holds. This does not call a payment gateway refund.
              </p>
              <Textarea
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="Cancellation reason (required)"
                rows={3}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCancelTarget(null)}>Back</Button>
              <Button variant="destructive" disabled={cancelMutation.isPending} onClick={confirmCancel}>
                {cancelMutation.isPending ? "Cancelling…" : "Cancel Order"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </PageLayout>
  );
}
