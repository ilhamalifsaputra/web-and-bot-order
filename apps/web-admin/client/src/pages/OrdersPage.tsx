import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Eye, MoreVertical, RefreshCw, Send, ShoppingCart, X, XCircle } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { apiGet, apiPost } from "../api/client";
import { UnresolvedAtSupplierBadge } from "../components/orders/UnresolvedAtSupplierBadge";
import { formatCurrencyParts } from "../components/shared/CurrencyAmount.helpers";
import { DataTable } from "../components/shared/DataTable";
import { DateInput } from "../components/shared/DateInput";
import { EmptyState } from "../components/shared/EmptyState";
import { FilterBar } from "../components/shared/FilterBar";
import { OrderStatusBadge } from "../components/shared/OrderStatusBadge";
import { PageHeader } from "../components/shared/PageHeader";
import { PageLayout } from "../components/shared/PageLayout";
import { Pagination } from "../components/shared/Pagination";
import { PaymentMethodBadge } from "../components/shared/PaymentMethodBadge";
import { SearchBar } from "../components/shared/SearchBar";
import { useOrdersKpis } from "../hooks/useOrdersKpis";
import { describeError } from "../lib/errorMessages";
import { DIGIFLAZZ_UNRESOLVED, orderStatusLabel } from "../lib/orderStatus";
import { PAYMENT_METHOD_LABELS, paymentMethodLabel } from "../lib/paymentMethod";
import { visibleSelection } from "../lib/selection";
import { OrdersKpiRow } from "./orders/OrdersKpiRow";
import { OrderStatusTabs } from "./orders/OrderStatusTabs";
import { statusesForTab, type StatusTabKey } from "./orders/OrderStatusTabs.helpers";

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
  /** "PRODUCT" (normal purchase) or "WALLET_TOPUP" (zero OrderItem rows —
   * the buyer topped up their wallet balance, not bought a SKU). Support
   * surfaces need to see top-ups; the Products column below shows a
   * distinct label for them instead of trying to read a product name off
   * an empty items array. */
  kind: string;
  currency: string;
  totalAmount: string;
  paymentMethod: string;
  createdAt: string;
  createdAtDisplay: string | null;
  /** Guest buyers carry no fullName/username/telegramId at all — only
   * `isGuest` and the contact `guestEmail` they typed at checkout. The
   * Customer column has to render off those instead. */
  user: {
    id: number;
    fullName: string | null;
    username: string | null;
    telegramId: string | null;
    isGuest: boolean;
    guestEmail: string | null;
  } | null;
  items: OrderItemRow[];
  /** Digiflazz's own sub-status (null for any order not routed there). The
   * list marks `unresolved_at_supplier` beside the status badge. `optional`
   * only because older cached/mocked rows predate the field. */
  digiflazzStatus?: string | null;
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

/** The one narrowing the list accepts beyond status: orders unresolved at
 * Digiflazz (`?digiflazz=unresolved`, the Operation Center card's link). */
type DigiflazzFilter = "" | "unresolved";

function digiflazzFilterFrom(value: string | null): DigiflazzFilter {
  return value === "unresolved" ? "unresolved" : "";
}

interface Filters {
  status: string;
  digiflazz: DigiflazzFilter;
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
      if (filters.digiflazz) params.set("digiflazz", filters.digiflazz);
      if (filters.paymentMethod) params.set("paymentMethod", filters.paymentMethod);
      if (filters.q) params.set("q", filters.q);
      if (filters.since) params.set("since", filters.since);
      if (filters.until) params.set("until", filters.until);
      if (filters.page > 1) params.set("page", String(filters.page));
      if (filters.pageSize !== 20) params.set("pageSize", String(filters.pageSize));
      return apiGet<OrdersData>(`/api/orders?${params.toString()}`);
    },
  });
}

const PAYMENT_METHOD_VALUES = Object.keys(PAYMENT_METHOD_LABELS);

export function OrdersPage() {
  const fieldId = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialStatus = searchParams.get("status") ?? "";
  // Lets other pages (e.g. Support's "Order History" row action) deep-link
  // straight into a pre-filtered Orders search via /orders?q=<term>.
  const initialQ = searchParams.get("q") ?? "";
  const initialDigiflazz = digiflazzFilterFrom(searchParams.get("digiflazz"));

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
    digiflazz: initialDigiflazz,
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
    onError: (e: Error) => toast.error(describeError(e)),
  });

  const resendRequests = useRef(new Set<number>());
  const [resendingIds, setResendingIds] = useState<number[]>([]);
  useEffect(() => {
    const requests = resendRequests.current;
    return () => { requests.clear(); };
  }, []);
  async function resendDelivery(orderId: number) {
    if (resendRequests.current.has(orderId)) return;
    resendRequests.current.add(orderId);
    setResendingIds(current => [...current, orderId]);
    try {
      await apiPost(`/api/orders/${orderId}/resend`, {});
      if (resendRequests.current.has(orderId)) toast.success("Delivery credentials resent.");
    } catch (error) {
      if (resendRequests.current.has(orderId)) toast.error(describeError(error as Error));
    } finally {
      if (resendRequests.current.delete(orderId)) setResendingIds(current => current.filter(id => id !== orderId));
    }
  }

  const bulkMutation = useMutation({
    mutationFn: (vars: { ids: number[]; action: "deliver" | "resend" }) =>
      apiPost<BulkActionResult>("/api/orders/bulk-action", vars),
    onSuccess: (result) => {
      invalidateAll();
      setSelected(new Set());
      toast.success(`${result.succeeded.length} succeeded, ${result.failed.length} failed.`);
    },
    onError: (e: Error) => toast.error(describeError(e)),
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
    onError: (e: Error) => toast.error(describeError(e)),
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
  // What the bulk bar counts and the export link carries. The bulk actions
  // already scope themselves through eligibleSelectedIds(), which filters
  // pageOrders, so they were never exposed to a stale id.
  const visibleSelected = visibleSelection(selected, pageOrders, (o) => o.id);

  function selectTab(tab: StatusTabKey) {
    setActiveTab(tab);
    setDraft((d) => ({ ...d, status: "" })); // clear the granular override so the tab's bucket is what's shown
    const status = statusesForTab(tab);
    // A tab is a fresh view, so it drops the unresolved-at-supplier narrowing.
    setFilters((f) => ({ ...f, status, digiflazz: "", page: 1 }));
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
    setSearchParams(listSearchParams(status, filters.digiflazz));
  }

  function clearDigiflazzFilter() {
    setFilters((f) => ({ ...f, digiflazz: "", page: 1 }));
    setSearchParams(listSearchParams(filters.status, ""));
  }

  function clearFilters() {
    setActiveTab("all");
    setDraft({ status: "", paymentMethod: "", q: "", since: "", until: "" });
    setFilters({ status: "", digiflazz: "", paymentMethod: "", q: "", since: "", until: "", page: 1, pageSize: 20 });
    setSearchParams({});
  }

  const hasActiveFilter = Boolean(filters.status || filters.digiflazz || filters.paymentMethod || filters.q || filters.since || filters.until);

  const { exportParams } = buildOrderExportParams({ filters });

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
      // Drops everything rather than pruning visible ids: a refetch can remove a row
      // with no filter/page change, and pruning would strand its id in the selection.
      if (allOnPageSelected) return new Set();
      const next = new Set(prev);
      pageOrders.forEach((o) => next.add(o.id));
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

      <OrdersFilters applyFilters={applyFilters} clearFilters={clearFilters} draft={draft} setDraft={setDraft} fieldId={fieldId} statuses={statuses} />

      {filters.digiflazz === "unresolved" && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <span className="inline-flex items-center gap-1 rounded-full border border-line bg-card py-0.5 pr-1 pl-3 text-ink">
            Only orders unresolved at the supplier
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Show all orders, not only unresolved ones"
              onClick={clearDigiflazzFilter}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </span>
        </div>
      )}

      <OrdersBulkActions visibleSelected={visibleSelected} bulkMutation={bulkMutation} runBulk={runBulk} cancelMutation={cancelMutation} eligibleSelectedIds={eligibleSelectedIds} openCancelDialog={openCancelDialog} setSelected={setSelected} />

      <OrdersSelectAllOrdersOnThis allOnPageSelected={allOnPageSelected} toggleSelectAllOnPage={toggleSelectAllOnPage} selected={selected} toggleSelected={toggleSelected} navigate={navigate} deliverMutation={deliverMutation} resendingIds={resendingIds} resendDelivery={resendDelivery} openCancelDialog={openCancelDialog} pageOrders={pageOrders} isLoading={isLoading} refetch={refetch} hasActiveFilter={hasActiveFilter} clearFilters={clearFilters} />

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

      <Orders cancelTarget={cancelTarget} setCancelTarget={setCancelTarget} cancelReason={cancelReason} setCancelReason={setCancelReason} cancelMutation={cancelMutation} confirmCancel={confirmCancel} />
    </PageLayout>
  );
}

function OrdersFilters({ applyFilters, clearFilters, draft, setDraft, fieldId, statuses }: {
  applyFilters: () => void;
  clearFilters: () => void;
  draft: { status: string; paymentMethod: string; q: string; since: string; until: string; };
  setDraft: import("react").Dispatch<import("react").SetStateAction<{ status: string; paymentMethod: string; q: string; since: string; until: string; }>>;
  fieldId: string;
  statuses: string[];
}) {
  return (<FilterBar onApply={applyFilters} onClear={clearFilters} className="mb-4">
    <SearchBar
      value={draft.q}
      onChange={(v) => setDraft((f) => ({ ...f, q: v }))}
      onSearch={applyFilters}
      placeholder="Search order code, customer or product..."
      className="w-full sm:w-[420px]"
    />

    <div className="flex flex-col gap-1">
      <label htmlFor={`${fieldId}-status-1`} className="text-xs text-ink-soft">Status</label>
      <Select
        value={draft.status || "_all_"}
        onValueChange={(v) => setDraft((f) => ({ ...f, status: v === "_all_" ? "" : v }))}
      >
        <SelectTrigger id={`${fieldId}-status-1`} className="w-40">
          <SelectValue placeholder="All statuses" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="_all_">All</SelectItem>
          {/* A deep link like the dashboard's Pending Payments card carries
                  several statuses; without an item for it the trigger reads blank. */}
          {draft.status.includes(",") && <SelectItem value={draft.status}>Several statuses</SelectItem>}
          {statuses.map((s) => (
            <SelectItem key={s} value={s}>
              {orderStatusLabel(s)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>

    <div className="flex flex-col gap-1">
      <label htmlFor={`${fieldId}-payment-method-2`} className="text-xs text-ink-soft">Payment Method</label>
      <Select
        value={draft.paymentMethod || "_all_"}
        onValueChange={(v) => setDraft((f) => ({ ...f, paymentMethod: v === "_all_" ? "" : v }))}
      >
        <SelectTrigger id={`${fieldId}-payment-method-2`} className="w-40">
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
      <label htmlFor={`${fieldId}-from-3`} className="text-xs text-ink-soft">From</label>
      <DateInput id={`${fieldId}-from-3`}
        value={draft.since}
        onChange={(e) => setDraft((f) => ({ ...f, since: e.target.value }))}
        className="w-36"
      />
    </div>

    <div className="flex flex-col gap-1">
      <label htmlFor={`${fieldId}-to-4`} className="text-xs text-ink-soft">To</label>
      <DateInput id={`${fieldId}-to-4`}
        value={draft.until}
        onChange={(e) => setDraft((f) => ({ ...f, until: e.target.value }))}
        className="w-36"
      />
    </div>
  </FilterBar>);
}

function OrdersSelectAllOrdersOnThis({ allOnPageSelected, toggleSelectAllOnPage, selected, toggleSelected, navigate, deliverMutation, resendingIds, resendDelivery, openCancelDialog, pageOrders, isLoading, refetch, hasActiveFilter, clearFilters }: {
  allOnPageSelected: boolean;
  toggleSelectAllOnPage: () => void;
  selected: Set<number>;
  toggleSelected: (id: number) => void;
  navigate: import("react-router-dom").NavigateFunction;
  deliverMutation: import("@tanstack/react-query").UseMutationResult<unknown, Error, number, unknown>;
  resendingIds: number[];
  resendDelivery: (orderId: number) => Promise<void>;
  openCancelDialog: (ids: number[]) => void;
  pageOrders: OrderRow[];
  isLoading: boolean;
  refetch: (options?: import("@tanstack/react-query").RefetchOptions) => Promise<import("@tanstack/react-query").QueryObserverResult<NoInfer<OrdersData>, Error>>;
  hasActiveFilter: boolean;
  clearFilters: () => void;
}) {
  return (<Card>
    <CardContent>
      <DataTable
        nested
        stickyHeader
        columns={[
          {
            key: "select",
            kind: "selection",
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
            render: (row) => {
              // A guest has no name of any kind, so the default branch below
              // would print a bare "—" and leave the admin with nothing to
              // act on. Show the Guest marker plus the contact email (the
              // guest's actual identity here) — and, if that email is
              // somehow missing, say that outright rather than blank out.
              if (row.user?.isGuest) {
                return (
                  <div className="max-w-[240px]">
                    <div className="flex min-w-0 items-start gap-2">
                      <Badge variant="secondary" className="shrink-0">Guest</Badge>
                      {/* The only way to reach a guest buyer, so it wraps and
                              stays fully readable — never truncated. whitespace-normal
                              defeats TableCell's default nowrap, matching the
                              treatment on OrderDetailPage. */}
                      <span className="text-sm break-all whitespace-normal text-ink">
                        {row.user.guestEmail ?? "No contact email"}
                      </span>
                    </div>
                    <div className="text-xs text-ink-soft">Guest checkout — no account</div>
                  </div>
                );
              }
              return (
                <div className="max-w-[240px]">
                  <div
                    className="truncate text-sm text-ink"
                    title={row.user?.fullName ?? row.user?.username ?? undefined}
                  >
                    {row.user?.fullName ?? row.user?.username ?? "—"}
                  </div>
                  <div className="truncate text-xs text-ink-soft">
                    {row.user?.telegramId ? `Telegram ${row.user.telegramId}` : row.user ? "Registered Customer" : "—"}
                  </div>
                </div>
              );
            },
          },
          {
            key: "products",
            header: "Product Count",
            render: (row) => {
              if (row.kind === "WALLET_TOPUP") {
                return <Badge variant="secondary">Wallet Top-Up ({row.currency})</Badge>;
              }
              if (row.items.length === 0) return <span className="text-sm text-ink-soft">—</span>;
              const first = row.items[0]!;
              const extra = row.items.length - 1;
              return (
                // The "+N more" suffix must never be the part that gets cut,
                // so only the product name truncates.
                <span className="flex max-w-[240px] items-baseline text-sm text-ink">
                  <span className="truncate" title={first.product.name}>{first.product.name}</span>
                  {extra > 0 && <span className="ml-1 shrink-0 text-ink-soft">+{extra}</span>}
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
            render: (row) =>
              row.digiflazzStatus === DIGIFLAZZ_UNRESOLVED ? (
                <span className="flex flex-wrap items-center gap-1">
                  <OrderStatusBadge status={row.status} />
                  <UnresolvedAtSupplierBadge />
                </span>
              ) : (
                <OrderStatusBadge status={row.status} />
              ),
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
                      <DropdownMenuItem disabled={resendingIds.includes(row.id)} onSelect={() => void resendDelivery(row.id)}>
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
    </CardContent>
  </Card>);
}

function Orders({ cancelTarget, setCancelTarget, cancelReason, setCancelReason, cancelMutation, confirmCancel }: {
  cancelTarget: { ids: number[]; } | null;
  setCancelTarget: import("react").Dispatch<import("react").SetStateAction<{ ids: number[]; } | null>>;
  cancelReason: string;
  setCancelReason: import("react").Dispatch<import("react").SetStateAction<string>>;
  cancelMutation: import("@tanstack/react-query").UseMutationResult<BulkActionResult, Error, { ids: number[]; reason: string; }, unknown>;
  confirmCancel: () => void;
}) {
  return (cancelTarget && (
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
  ));
}

function OrdersBulkActions({ visibleSelected, bulkMutation, runBulk, cancelMutation, eligibleSelectedIds, openCancelDialog, setSelected }: {
  visibleSelected: Set<number>;
  bulkMutation: import("@tanstack/react-query").UseMutationResult<BulkActionResult, Error, { ids: number[]; action: "deliver" | "resend"; }, unknown>;
  runBulk: (action: "deliver" | "resend", predicate: (row: OrderRow) => boolean, ineligibleMessage: string) => void;
  cancelMutation: import("@tanstack/react-query").UseMutationResult<BulkActionResult, Error, { ids: number[]; reason: string; }, unknown>;
  eligibleSelectedIds: (predicate: (row: OrderRow) => boolean) => number[];
  openCancelDialog: (ids: number[]) => void;
  setSelected: import("react").Dispatch<import("react").SetStateAction<Set<number>>>;
}) {
  return (visibleSelected.size > 0 && (
    <div className="sticky bottom-4 z-10 mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-card px-3 py-2 text-sm shadow-lift transition-[color,background-color,border-color,opacity,transform] duration-150">
      <span className="text-ink-soft">{visibleSelected.size} selected</span>
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
      <a href={`/api/orders/export?ids=${Array.from(visibleSelected).join(",")}`}>
        <Button size="sm" variant="ghost">Export</Button>
      </a>
      <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
        Clear
      </Button>
    </div>
  ));
}

function buildOrderExportParams({ filters }: {
  filters: Filters;
}) {
  const exportParams = new URLSearchParams();

  if (filters.status) exportParams.set("status", filters.status);

  if (filters.digiflazz) exportParams.set("digiflazz", filters.digiflazz);

  if (filters.paymentMethod) exportParams.set("paymentMethod", filters.paymentMethod);

  if (filters.q) exportParams.set("q", filters.q);

  if (filters.since) exportParams.set("since", filters.since);

  if (filters.until) exportParams.set("until", filters.until);
  return { exportParams };
}

/** The list's URL: the status filter, plus the unresolved-at-supplier
 * narrowing when it is on, so a reload or a shared link keeps both. */
function listSearchParams(status: string, digiflazz: DigiflazzFilter): Record<string, string> {
  const params: Record<string, string> = {};
  if (status) params.status = status;
  if (digiflazz) params.digiflazz = digiflazz;
  return params;
}
