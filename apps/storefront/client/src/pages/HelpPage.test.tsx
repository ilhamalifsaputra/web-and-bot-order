import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import HelpPage from "./HelpPage";
import { apiGet, apiPost, apiPostFormWithProgress } from "../api/client";
import { t } from "../lib/i18n";
import type { AccountOrdersData, SupportData, SupportFormOptions, TicketDetailData } from "../api/types";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPostFormWithProgress: vi.fn(),
}));

// --- Fixtures ---------------------------------------------------------

const emptyList: SupportData = {
  tickets: [],
  total: 0,
  page: 1,
  page_size: 10,
  stats: { all: 0, waiting_for_you: 0, waiting_for_support: 0, in_progress: 0, resolved: 0, closed: 0 },
};

const ticket1 = {
  id: 101,
  message: "Cannot log in to my account\nI keep getting an error.",
  status: "open",
  created_at_display: "2026-08-01 10:00",
  admin_reply: null,
  attachments: [],
  subject: "Cannot log in to my account",
  order_code: "ORD-2001",
  product_name: "Alight Motion",
  updated_at_iso: "2026-08-01T10:05:00.000Z",
};

const ticket2 = {
  id: 102,
  message: "Refund request for wrong item",
  status: "waiting_customer",
  created_at_display: "2026-08-02 09:00",
  admin_reply: "We need more info",
  attachments: [],
  subject: "Refund request for wrong item",
  order_code: "ORD-2002",
  product_name: "Canva Pro",
  updated_at_iso: "2026-08-02T09:00:00.000Z",
};

const ticket3 = {
  id: 103,
  message: "Thanks, all good now",
  status: "resolved",
  created_at_display: "2026-08-03 09:00",
  admin_reply: null,
  attachments: [],
  subject: "Thanks, all good now",
  order_code: null,
  product_name: null,
  updated_at_iso: "2026-08-03T09:00:00.000Z",
};

const populatedList: SupportData = {
  tickets: [ticket1, ticket2, ticket3],
  total: 3,
  page: 1,
  page_size: 10,
  stats: { all: 3, waiting_for_you: 1, waiting_for_support: 1, in_progress: 0, resolved: 1, closed: 0 },
};

const emptyFormOptions: SupportFormOptions = { products: [] };
const populatedFormOptions: SupportFormOptions = {
  products: [
    { id: 1, name: "Alight Motion" },
    { id: 2, name: "Canva Pro" },
  ],
};

const emptyOrders: AccountOrdersData = { orders: [] };
const populatedOrders: AccountOrdersData = {
  orders: [
    { code: "ORD-2001", status: "delivered", total: "150000", created_at_display: "2026-08-01 09:00", items: "Alight Motion 1 year" },
  ],
};

const ticketDetailFixture: TicketDetailData = {
  ticket: {
    id: 101,
    message: "Cannot log in to my account\nI keep getting an error.",
    status: "open",
    created_at_display: "2026-08-01 10:00",
    admin_reply: null,
    replied_at_display: null,
    closed: false,
    closed_at_display: null,
    reopenable: false,
    attachments: [],
  },
  messages: [],
  order: null,
};

// --- Harness ------------------------------------------------------------

type ListOverride = SupportData | ((params: URLSearchParams) => SupportData);

function renderHelp(
  overrides: {
    list?: ListOverride;
    formOptions?: SupportFormOptions;
    orders?: AccountOrdersData;
    ticketDetail?: TicketDetailData;
  } = {},
  initialUrl = "/help",
) {
  (apiGet as Mock).mockImplementation(async (path: string) => {
    if (path.startsWith("/api/v1/account/support?")) {
      const params = new URLSearchParams(path.slice(path.indexOf("?")));
      if (typeof overrides.list === "function") return overrides.list(params);
      return overrides.list ?? emptyList;
    }
    if (path === "/api/v1/account/support/new") return overrides.formOptions ?? emptyFormOptions;
    if (path === "/api/v1/account/orders") return overrides.orders ?? emptyOrders;
    if (/^\/api\/v1\/account\/support\/\d+$/.test(path)) return overrides.ticketDetail ?? ticketDetailFixture;
    throw new Error(`unexpected apiGet ${path}`);
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialUrl]}>
        <Routes>
          <Route path="/help" element={<HelpPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function subjectInput() {
  return screen.getByLabelText(t("web.support_field_subject"), { exact: false });
}
function categorySelect() {
  return screen.getByLabelText(t("web.support_field_category"), { exact: false });
}
function productSelect() {
  return screen.getByLabelText(t("web.support_field_product"), { exact: false });
}
function descriptionInput() {
  return screen.getByLabelText(t("web.support_field_description"), { exact: false });
}
function submitButton() {
  return screen.getByRole("button", { name: new RegExp(t("web.support_send_ticket"), "i") });
}

/** Fills every required field of the create-ticket form with valid values
 * (client-validation-passing) so a submit reaches the mutation. */
async function fillCreateForm(overrides: { subject?: string; category?: string; productId?: string; description?: string } = {}) {
  const {
    subject = "Cannot access my order",
    category = "ACCOUNT",
    productId = "1",
    description = "It just will not load no matter what I try.",
  } = overrides;
  await userEvent.type(subjectInput(), subject);
  await userEvent.selectOptions(categorySelect(), category);
  await userEvent.selectOptions(productSelect(), productId);
  await userEvent.type(descriptionInput(), description);
}

describe("HelpPage", () => {
  let originalLocation: PropertyDescriptor | undefined;

  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
    originalLocation = Object.getOwnPropertyDescriptor(window, "location");
    URL.createObjectURL = vi.fn(() => "blob:mock-preview");
    URL.revokeObjectURL = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    if (originalLocation) Object.defineProperty(window, "location", originalLocation);
    vi.useRealTimers();
  });

  it("renders the hero, the create-ticket card's key fields, and a populated tickets list", async () => {
    renderHelp({ list: populatedList, formOptions: populatedFormOptions, orders: populatedOrders });

    expect(await screen.findByRole("heading", { name: t("web.help_title"), level: 1 })).toBeInTheDocument();
    expect(subjectInput()).toBeInTheDocument();
    expect(categorySelect()).toBeInTheDocument();
    expect(productSelect()).toBeInTheDocument();
    expect(descriptionInput()).toBeInTheDocument();

    expect(await screen.findByText("Cannot log in to my account")).toBeInTheDocument();
    expect(screen.getByText("Refund request for wrong item")).toBeInTheDocument();
    expect(screen.getByText("Thanks, all good now")).toBeInTheDocument();
    expect(screen.getByText("Waiting for Support")).toBeInTheDocument();
    expect(screen.getByText("Waiting for You")).toBeInTheDocument();
    expect(screen.getByText("Resolved")).toBeInTheDocument();
  });

  it("populates the Category and Product dropdowns from support-form-options", async () => {
    renderHelp({ list: emptyList, formOptions: populatedFormOptions, orders: emptyOrders });
    expect(await screen.findByRole("option", { name: "Alight Motion" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Canva Pro" })).toBeInTheDocument();
  });

  it("populates the Order dropdown from account-orders", async () => {
    renderHelp({ list: emptyList, formOptions: emptyFormOptions, orders: populatedOrders });
    expect(await screen.findByRole("option", { name: "#ORD-2001 — Alight Motion 1 year" })).toBeInTheDocument();
  });

  it("submits the create form (no files) as JSON with the exact typed field values", async () => {
    renderHelp({ list: emptyList, formOptions: populatedFormOptions, orders: emptyOrders });
    await screen.findByRole("heading", { name: t("web.help_title"), level: 1 });
    (apiPost as Mock).mockResolvedValue({ ok: true, ticket_id: 1 });

    await fillCreateForm({
      subject: "Cannot access my order",
      category: "ACCOUNT",
      productId: "1",
      description: "It just will not load no matter what I try.",
    });
    await userEvent.click(submitButton());

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/v1/account/support/new", {
        subject: "Cannot access my order",
        category: "ACCOUNT",
        product_id: 1,
        description: "It just will not load no matter what I try.",
      }),
    );
    expect(apiPostFormWithProgress).not.toHaveBeenCalled();
  });

  it("clears the form and shows a success toast on a plain success response", async () => {
    renderHelp({ list: emptyList, formOptions: populatedFormOptions, orders: emptyOrders });
    await screen.findByRole("heading", { name: t("web.help_title"), level: 1 });
    (apiPost as Mock).mockResolvedValue({ ok: true, ticket_id: 42 });

    await fillCreateForm();
    await userEvent.click(submitButton());

    expect(await screen.findByText(t("web.support_ticket_created", { id: 42 }))).toBeInTheDocument();
    expect(subjectInput()).toHaveValue("");
  });

  it("selects the existing ticket and shows an info toast on a duplicate response, without clearing the form", async () => {
    renderHelp({ list: emptyList, formOptions: populatedFormOptions, orders: emptyOrders });
    await screen.findByRole("heading", { name: t("web.help_title"), level: 1 });
    (apiPost as Mock).mockResolvedValue({ ok: false, duplicate: true, ticket_id: 99 });

    await fillCreateForm({ subject: "Still waiting on my refund" });
    await userEvent.click(submitButton());

    expect(await screen.findByText(t("web.support_duplicate_redirect"))).toBeInTheDocument();
    expect(subjectInput()).toHaveValue("Still waiting on my refund");
  });

  it("renders a field-error response under the Subject field, not as a toast", async () => {
    renderHelp({ list: emptyList, formOptions: populatedFormOptions, orders: emptyOrders });
    await screen.findByRole("heading", { name: t("web.help_title"), level: 1 });
    (apiPost as Mock).mockRejectedValue(new Error("web.support_subject_required"));

    await fillCreateForm();
    await userEvent.click(submitButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(t("web.support_subject_required"));
    expect(screen.queryByText(t("web.support_ticket_created", { id: 1 }))).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("clicking a status-filter pill re-queries the list with that status", async () => {
    renderHelp({
      list: (params) => (params.get("status") === "waiting_for_you" ? { ...populatedList, tickets: [ticket2] } : populatedList),
      formOptions: populatedFormOptions,
      orders: populatedOrders,
    });
    await screen.findByText("Cannot log in to my account");

    await userEvent.click(screen.getByRole("button", { name: /Waiting for you/ }));

    await waitFor(() => {
      const calls = (apiGet as Mock).mock.calls.map((c) => c[0] as string);
      expect(calls.some((u) => u.includes("status=waiting_for_you"))).toBe(true);
    });
    expect(await screen.findByText("Refund request for wrong item")).toBeInTheDocument();
    expect(screen.queryByText("Cannot log in to my account")).not.toBeInTheDocument();
  });

  it("debounces the search box before it reaches the query", async () => {
    renderHelp({ list: populatedList, formOptions: populatedFormOptions, orders: populatedOrders });
    await screen.findByText("Cannot log in to my account");
    (apiGet as Mock).mockClear();

    vi.useFakeTimers();
    try {
      const search = screen.getByLabelText(t("web.help_search_tickets"));
      fireEvent.change(search, { target: { value: "refund" } });

      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect((apiGet as Mock).mock.calls.some((c) => (c[0] as string).includes("q=refund"))).toBe(false);

      act(() => {
        vi.advanceTimersByTime(150); // total 350ms > SEARCH_DEBOUNCE_MS
      });
      await vi.waitFor(() =>
        expect((apiGet as Mock).mock.calls.some((c) => (c[0] as string).includes("q=refund"))).toBe(true),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("selecting a ticket row opens the InlineTicketPanel", async () => {
    renderHelp({ list: populatedList, formOptions: populatedFormOptions, orders: populatedOrders });
    await screen.findByText("Cannot log in to my account");

    fireEvent.click(screen.getByRole("button", { name: t("web.help_ticket_row_label", { id: "#TK-101" }) }));

    await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/api/v1/account/support/101"));
    expect(await screen.findByRole("button", { name: t("web.help_back_to_tickets") })).toBeInTheDocument();
  });

  it("Back to tickets clears the selection and the panel disappears", async () => {
    renderHelp({ list: populatedList, formOptions: populatedFormOptions, orders: populatedOrders });
    await screen.findByText("Cannot log in to my account");

    fireEvent.click(screen.getByRole("button", { name: t("web.help_ticket_row_label", { id: "#TK-101" }) }));
    await screen.findByRole("button", { name: t("web.help_back_to_tickets") });

    fireEvent.click(screen.getByRole("button", { name: t("web.help_back_to_tickets") }));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: t("web.help_back_to_tickets") })).not.toBeInTheDocument(),
    );
  });

  it("redirects to login on a 401 from the support list query", async () => {
    const assignSpy = vi.fn();
    Object.defineProperty(window, "location", { value: { assign: assignSpy }, writable: true, configurable: true });

    renderHelp({
      list: () => {
        const err = new Error("unauthorized") as Error & { status?: number };
        err.status = 401;
        throw err;
      },
      formOptions: emptyFormOptions,
      orders: emptyOrders,
    });

    await waitFor(() => expect(assignSpy).toHaveBeenCalledWith("/login?next=%2Fhelp"));
  });

  it("reflects the status and sort URL params as active on first render", async () => {
    renderHelp(
      { list: populatedList, formOptions: populatedFormOptions, orders: populatedOrders },
      "/help?status=waiting_for_support&sort=created_desc",
    );
    await screen.findByText("Cannot log in to my account");

    expect(screen.getByRole("button", { name: /Waiting for support/, pressed: true })).toBeInTheDocument();
    expect(screen.getByLabelText(t("web.sort_label"))).toHaveValue("created_desc");
  });
});
