/**
 * /help — Help & Support page: assembles SupportHero, NewTicketCard,
 * MyTicketsCard and InlineTicketPanel (Tasks 13-17) into the storefront's
 * single ticket-support surface. Nav/footer/CTAs (Layout.tsx, StaticPage.tsx)
 * now point here instead of the older /account/support flow; SupportPage.tsx
 * and TicketDetailPage.tsx stay mounted at their old URLs untouched.
 *
 * URL-param state (status/q/sort/page/ticket, via useSearchParams) makes the
 * page shareable and back-button-friendly — see setParam() below. The search
 * box is debounced (300ms) before it reaches the URL/query key so every
 * keystroke doesn't refetch; MyTicketsCard is still handed the undebounced
 * local value so typing itself feels instant.
 *
 * Wider than every other account page: the shared <main> in Layout.tsx caps
 * out at max-w-6xl (~1152px), but this page's two-column form+list layout
 * wants more room, so it breaks out to a ~1440px container via the
 * `mx-[calc(50%_-_50vw)]` full-bleed technique below (escaping a centered
 * parent's max-width without touching the parent itself). Deliberately NOT
 * the more common `w-screen` + `-mx-[50vw]` + `left-1/2` version of this
 * trick: `100vw` includes the vertical scrollbar's width wherever the OS
 * renders one inline (Windows/Linux Chrome), which is narrower than the
 * page's real available width — that mismatch pushed this wrapper a
 * scrollbar's-width past the right edge and produced a real horizontal
 * overflow (reported: page not fitting at 100% zoom). `calc(50% - 50vw)`
 * margins avoid a `width` override entirely: the box keeps its normal
 * block-level width (100% of its true, scrollbar-excluded containing
 * block), and the two margins pull its edges out to the actual viewport
 * edges using the same scrollbar-inclusive `vw` unit only as an offset, not
 * as the box's own size — so the arithmetic self-corrects regardless of
 * whether a scrollbar is present. `overflow-x-clip` stays on as a defensive
 * backstop against any residual sub-pixel rounding.
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPostFormWithProgress } from "../api/client";
import type { AccountOrdersData, SupportData, SupportFormOptions, SupportTicketStats } from "../api/types";
import { t } from "../lib/i18n";
import SupportHero from "../components/shop/SupportHero";
import NewTicketCard, { type NewTicketFormValue } from "../components/shop/NewTicketCard";
import MyTicketsCard, { type TicketSortKey } from "../components/shop/MyTicketsCard";
import type { TicketStatusFilterKey } from "../components/shop/TicketStatusFilterPills";
import InlineTicketPanel from "../components/shop/InlineTicketPanel";
import Toast from "../components/shop/Toast";

const EMPTY_STATS: SupportTicketStats = {
  all: 0,
  waiting_for_you: 0,
  waiting_for_support: 0,
  in_progress: 0,
  resolved: 0,
  closed: 0,
};

const EMPTY_FORM: NewTicketFormValue = {
  subject: "",
  category: "",
  productId: "",
  orderCode: "",
  description: "",
  files: [],
};

type CreateTicketResponse = { ok: boolean; ticket_id: number | null; duplicate?: boolean };

type FieldName = "subject" | "category" | "product" | "description";

/** Server 400 error keys (POST /api/v1/account/support/new) -> the
 * NewTicketCard field they belong under. Anything not in this map is a
 * page-level toast instead of a field-level message. */
const FIELD_ERROR_KEY: Record<string, FieldName> = {
  "web.support_subject_required": "subject",
  "web.support_category_required": "category",
  "web.support_product_invalid": "product",
  "web.support_description_required": "description",
};

const SEARCH_DEBOUNCE_MS = 300;

export default function HelpPage() {
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();

  const status = (params.get("status") as TicketStatusFilterKey) || "all";
  const sort = (params.get("sort") as TicketSortKey) || "latest_update";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const q = params.get("q") ?? "";
  const ticketParam = params.get("ticket");
  const selectedTicketId = ticketParam ? Number(ticketParam) : null;

  /** Updates one query param while preserving the rest. Functional form (vs.
   * building off the outer `params` snapshot) so a debounced search push
   * landing after a filter/sort click never clobbers it with a stale copy. */
  function setParam(key: string, value: string | null, opts?: { resetPage?: boolean }) {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set(key, value);
      else next.delete(key);
      if (opts?.resetPage) next.delete("page");
      return next;
    });
  }

  // The search box stays local so every keystroke is instant; it's only
  // pushed into the URL (and thus the list query's key) after
  // SEARCH_DEBOUNCE_MS of no typing.
  const [searchInput, setSearchInput] = useState(q);
  useEffect(() => {
    // The URL is the source of truth (back/forward nav, a pasted link) —
    // keep the local box in sync when `q` changes from outside a keystroke
    // here (this also fires right after our own debounced push, but setting
    // state to its current value is a no-op re-render-wise).
    setSearchInput(q);
  }, [q]);
  useEffect(() => {
    if (searchInput === q) return undefined;
    const timer = setTimeout(() => {
      setParam("q", searchInput || null, { resetPage: true });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const [formValue, setFormValue] = useState<NewTicketFormValue>(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [uploadProgress, setUploadProgress] = useState(0);
  const [toastText, setToastText] = useState<string | null>(null);
  const [toastKind, setToastKind] = useState<"success" | "error" | "info">("success");

  const {
    data: listData,
    isFetching: listFetching,
    error: listError,
  } = useQuery({
    queryKey: ["support-list", { status, q, sort, page }],
    queryFn: () =>
      apiGet<SupportData>(
        `/api/v1/account/support?status=${status}&q=${encodeURIComponent(q)}&sort=${sort}&page=${page}&page_size=10`,
      ),
    retry: false,
  });
  const { data: formOptions, error: formOptionsError } = useQuery({
    queryKey: ["support-form-options"],
    queryFn: () => apiGet<SupportFormOptions>("/api/v1/account/support/new"),
    retry: false,
  });
  const { data: ordersData, error: ordersError } = useQuery({
    queryKey: ["account-orders"],
    queryFn: () => apiGet<AccountOrdersData>("/api/v1/account/orders"),
    retry: false,
  });

  useEffect(() => {
    const anyUnauthorized = [listError, formOptionsError, ordersError].some(
      (err) => (err as (Error & { status?: number }) | null)?.status === 401,
    );
    if (anyUnauthorized) {
      window.location.assign("/login?next=" + encodeURIComponent("/help"));
    }
  }, [listError, formOptionsError, ordersError]);

  // Scrolls the panel into view whenever a *different* ticket becomes
  // selected (row click, or a create/duplicate response opening one) — not
  // on every re-render, since `selectedTicketId` only changes then.
  useEffect(() => {
    if (selectedTicketId == null) return;
    document.getElementById("inline-ticket-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selectedTicketId]);

  const createMutation = useMutation({
    mutationFn: (v: NewTicketFormValue) => {
      const body = {
        subject: v.subject,
        category: v.category,
        product_id: Number(v.productId),
        description: v.description,
        ...(v.orderCode ? { order_code: v.orderCode } : {}),
      };
      if (v.files.length === 0) {
        return apiPost<CreateTicketResponse>("/api/v1/account/support/new", body);
      }
      const form = new FormData();
      form.append("subject", v.subject);
      form.append("category", v.category);
      form.append("product_id", v.productId);
      form.append("description", v.description);
      if (v.orderCode) form.append("order_code", v.orderCode);
      for (const file of v.files) form.append("attachments", file);
      return apiPostFormWithProgress<CreateTicketResponse>("/api/v1/account/support/new", form, setUploadProgress);
    },
    onSuccess: (resp) => {
      if (resp.duplicate && resp.ticket_id != null) {
        // Short-circuit: don't clear the form (nothing was created) or treat
        // this as an error — just point the selection at the existing open
        // ticket and say so.
        setToastKind("info");
        setToastText(t("web.support_duplicate_redirect"));
        setParam("ticket", String(resp.ticket_id));
        return;
      }
      setFormValue(EMPTY_FORM);
      setFieldErrors({});
      queryClient.invalidateQueries({ queryKey: ["support-list"] });
      if (resp.ticket_id != null) {
        setToastKind("success");
        setToastText(t("web.support_ticket_created", { id: resp.ticket_id }));
        setParam("ticket", String(resp.ticket_id));
      }
    },
    onError: (err) => {
      const key = err instanceof Error ? err.message : "error.generic";
      const field = FIELD_ERROR_KEY[key];
      if (field) {
        setFieldErrors({ [field]: t(key) });
      } else {
        setToastKind("error");
        setToastText(t(key));
      }
    },
  });

  function submitNewTicket() {
    setFieldErrors({});
    setUploadProgress(0);
    createMutation.mutate(formValue);
  }

  const selectedSummary = listData?.tickets.find((tk) => tk.id === selectedTicketId);

  return (
    <div className="mx-[calc(50%_-_50vw)] overflow-x-clip">
      <div className="mx-auto max-w-[1440px] px-6 lg:px-12">
        <Toast text={toastText} onDismiss={() => setToastText(null)} kind={toastKind} />

        <SupportHero />

        <div className="grid gap-7 lg:grid-cols-2">
          <NewTicketCard
            value={formValue}
            onChange={(patch) => setFormValue((v) => ({ ...v, ...patch }))}
            products={formOptions?.products ?? []}
            orders={ordersData?.orders ?? []}
            errors={fieldErrors}
            onSubmit={submitNewTicket}
            isSubmitting={createMutation.isPending}
            uploadProgress={uploadProgress}
          />
          <MyTicketsCard
            tickets={listData?.tickets ?? []}
            stats={listData?.stats ?? EMPTY_STATS}
            total={listData?.total ?? 0}
            page={listData?.page ?? page}
            pageSize={listData?.page_size ?? 10}
            statusFilter={status}
            sort={sort}
            search={searchInput}
            isLoading={listFetching && !listData}
            selectedTicketId={selectedTicketId}
            onStatusFilterChange={(k) => setParam("status", k === "all" ? null : k, { resetPage: true })}
            onSortChange={(s) => setParam("sort", s === "latest_update" ? null : s, { resetPage: true })}
            onSearchChange={setSearchInput}
            onPageChange={(p) => setParam("page", p > 1 ? String(p) : null)}
            onSelectTicket={(id) => setParam("ticket", String(id))}
          />
        </div>

        {selectedTicketId != null && (
          <div className="mt-7">
            <InlineTicketPanel
              ticketId={selectedTicketId}
              summary={selectedSummary}
              onClose={() => setParam("ticket", null)}
              onMutated={() => queryClient.invalidateQueries({ queryKey: ["support-list"] })}
            />
          </div>
        )}
      </div>
    </div>
  );
}
