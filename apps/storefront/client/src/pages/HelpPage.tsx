import { useState, useEffect, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Send } from "lucide-react";
import { apiGet, apiPost } from "../api/client";
import type { SupportData } from "../api/types";
import { t } from "../lib/i18n";
import { tError } from "../lib/errors";
import { useSupportUploads } from "../lib/supportUploads";
import Button from "../components/ui/Button";
import FormField from "../components/ui/FormField";
import Select from "../components/ui/Select";
import Textarea from "../components/ui/Textarea";
import SupportUploadPicker from "../components/shop/SupportUploadPicker";
import { TicketCard } from "../components/shop/TicketRow";
import Spinner from "../components/shop/Spinner";

interface Category { key: string; issues: string[]; order: boolean }
interface Options { categories: Category[]; media: { enabled: boolean; imageBytes?: number; videoBytes?: number } }

export default function HelpPage() {
  const [params] = useSearchParams();
  const ticket = params.get("ticket");
  if (ticket && /^\d+$/.test(ticket)) return <Navigate to={`/account/support/${ticket}`} replace />;
  return <div className="mx-auto w-full min-w-0 max-w-6xl space-y-4">
    <header className="space-y-1"><h1 className="page-title">{t("helpdesk.title")}</h1><p className="text-sm text-ink-soft">{t("helpdesk.subtitle")}</p></header>
    <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]"><SupportTicketForm /><SupportTicketHistory /></div>
  </div>;
}

function SupportTicketForm() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [category, setCategory] = useState(() => params.get("order") ? "ORDER" : "");
  const [issue, setIssue] = useState("");
  const [order, setOrder] = useState(() => params.get("order") ?? "");
  const [description, setDescription] = useState("");
  const [requestId] = useState(() => crypto.randomUUID());
  const [formError, setFormError] = useState<string | null>(null);
  const options = useQuery({ queryKey: ["support-v2-options"], queryFn: () => apiGet<Options>("/api/v1/account/support/options"), retry: false });
  const uploads = useSupportUploads(undefined, options.data?.media);
  const orders = useQuery({ queryKey: ["account-orders"], queryFn: () => apiGet<{ orders: { code: string; items: string }[] }>("/api/v1/account/orders"), retry: false, enabled: category === "ORDER" || category === "PAYMENT" });
  const selected = options.data?.categories.find((c) => c.key === category);
  const create = useMutation({
    mutationFn: () => apiPost<{ ticket_id: number }>("/api/v1/account/support/v2", { category, issue, description, order_code: selected?.order ? order : undefined, request_id: requestId, attachment_ids: uploads.ids }),
    onSuccess: (response) => { void queryClient.invalidateQueries({ queryKey: ["support-list"] }); navigate(`/account/support/${response.ticket_id}`); },
    onError: (error) => setFormError(tError(error)),
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    if (create.isPending || uploads.busy) return;
    if (description.trim().length < 10) { setFormError(t("helpdesk.description_quality")); document.getElementById("support-description")?.focus(); return; }
    setFormError(null); create.mutate();
  }
  return (<section className="card min-w-0 p-4 sm:p-5" aria-labelledby="new-ticket-title">
        <h2 id="new-ticket-title" className="mb-4 text-base font-semibold">{t("helpdesk.new")}</h2>
        {options.isError ? <div role="alert" className="space-y-2 text-sm"><p>{tError(options.error)}</p>{(options.error as Error & { status?: number }).status === 401 && <Link className="link" to="/login?next=%2Fhelp">{t("web.login")}</Link>}<Button variant="soft" size="sm" onClick={() => void options.refetch()}>{t("helpdesk.retry")}</Button></div> : <form className="space-y-3" onSubmit={submit}>
          <fieldset disabled={create.isPending || !options.data} className="min-w-0 space-y-3">
            <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              <FormField className="[&>label]:normal-case [&>label]:tracking-normal" htmlFor="support-category" label={t("helpdesk.category")} required><Select id="support-category" required value={category} onChange={(event) => { setCategory(event.target.value); setIssue(""); setOrder(""); }}><option value="">{t("helpdesk.choose_category")}</option>{options.data?.categories.map((c) => <option key={c.key} value={c.key}>{t(`helpdesk.category_${c.key.toLowerCase()}`)}</option>)}</Select></FormField>
              <FormField className="[&>label]:normal-case [&>label]:tracking-normal" htmlFor="support-issue" label={t("helpdesk.issue_label")} required><Select id="support-issue" required value={issue} disabled={!selected} onChange={(event) => setIssue(event.target.value)}><option value="">{t("helpdesk.choose_issue")}</option>{selected?.issues.map((key) => <option key={key} value={key}>{t(`helpdesk.issue.${category.toLowerCase()}_${key}`)}</option>)}</Select></FormField>
            </div>
            {selected?.order && <><FormField className="[&>label]:normal-case [&>label]:tracking-normal" htmlFor="support-order" label={t("helpdesk.related_order")} hint={t("helpdesk.order_hint")}><input id="support-order" className="field w-full min-w-0" list="support-orders" value={order} onChange={(event) => setOrder(event.target.value)} placeholder={t("helpdesk.order_placeholder")} maxLength={100} /></FormField><datalist id="support-orders">{orders.data?.orders.map((o) => <option key={o.code} value={o.code}>{o.items}</option>)}</datalist>{orders.isError && <span role="alert" className="text-xs">{tError(orders.error)}</span>}</>}
            <FormField className="[&>label]:normal-case [&>label]:tracking-normal" htmlFor="support-description" label={t("helpdesk.description")} hint={t("helpdesk.description_hint")} error={formError ? <span role="alert">{formError}</span> : undefined} required><Textarea id="support-description" rows={3} required minLength={10} maxLength={2000} value={description} onChange={(event) => setDescription(event.target.value)} className="min-h-0 max-h-48 resize-y [field-sizing:content]" placeholder={t("helpdesk.description_placeholder")} /></FormField>
            <SupportUploadPicker uploads={uploads} enabled={options.data?.media.enabled ?? false} disabled={create.isPending} />
          </fieldset>
          <Button type="submit" variant="primary" className="w-full sm:w-auto" disabled={create.isPending || uploads.busy || !options.data}>{create.isPending ? <Spinner /> : <Send className="h-4 w-4" aria-hidden="true" />}{t("helpdesk.send_ticket")}</Button>
        </form>}
      </section>);
}

function SupportTicketHistory() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  useEffect(() => { const timer = setTimeout(() => { setQuery(search.trim()); setPage(1); }, 300); return () => clearTimeout(timer); }, [search]);
  const list = useQuery({ queryKey: ["support-list", filter, page, query], queryFn: () => apiGet<SupportData>(`/api/v1/account/support?status=${filter}&page=${page}&page_size=10&q=${encodeURIComponent(query)}`), retry: false });
  return (<section className="card min-w-0 p-4 sm:p-5" aria-labelledby="ticket-history-title">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="ticket-history-title" className="text-base font-semibold">{t("helpdesk.history")} <span className="text-sm font-normal text-ink-soft">{list.data?.total ?? ""}</span></h2><select className="field max-w-full text-sm" aria-label={t("helpdesk.filter")} value={filter} onChange={(event) => { setFilter(event.target.value); setPage(1); }}><option value="all">{t("helpdesk.all")}</option><option value="waiting_for_support">{t("helpdesk.status_new")}</option><option value="in_progress">{t("helpdesk.status_progress")}</option><option value="waiting_for_you">{t("web.ticket_status_waiting_you")}</option><option value="resolved">{t("helpdesk.resolved")}</option><option value="closed">{t("helpdesk.closed")}</option></select></div>
        <input type="search" className="field my-3 w-full" aria-label={t("web.help_search_tickets")} placeholder={t("web.help_search_tickets")} value={search} onChange={(event) => setSearch(event.target.value)} />
        {list.isLoading && <p role="status" className="py-4 text-sm text-ink-soft">{t("web.loading")}</p>}
        {list.isError && <div role="alert" className="space-y-2"><p className="text-sm">{tError(list.error)}</p><Button variant="soft" size="sm" onClick={() => void list.refetch()}>{t("helpdesk.retry")}</Button></div>}
        {!list.isLoading && !list.isError && !list.data?.tickets.length && <p className="py-6 text-center text-sm text-ink-soft">{t("web.no_tickets_desc")}</p>}
        <ul className="space-y-2">{list.data?.tickets.map((ticket) => <li key={ticket.id}><TicketCard ticket={ticket} onSelect={(id) => navigate(`/account/support/${id}`)} /></li>)}</ul>
        {(list.data?.total ?? 0) > 10 && <div className="mt-3 flex items-center justify-between gap-2"><Button variant="soft" size="sm" disabled={page === 1} onClick={() => setPage(page - 1)}>{t("helpdesk.previous")}</Button><span className="text-xs text-ink-soft">{page}</span><Button variant="soft" size="sm" disabled={page * 10 >= (list.data?.total ?? 0)} onClick={() => setPage(page + 1)}>{t("helpdesk.next")}<ArrowRight className="h-4 w-4" aria-hidden="true" /></Button></div>}
      </section>);
}
