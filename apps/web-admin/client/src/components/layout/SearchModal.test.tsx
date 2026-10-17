import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { SearchModal } from "./SearchModal";

function renderModal(onClose: () => void = () => {}) {
  return render(
    <MemoryRouter>
      <SearchModal open={true} onClose={onClose} />
    </MemoryRouter>,
  );
}

function mockSearchResponse(body: unknown) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }),
  );
}

function typeQuery(value: string) {
  fireEvent.change(screen.getByPlaceholderText(/search orders, products, users/i), { target: { value } });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("SearchModal", () => {
  it("starts a new opening empty and ignores the previous session's late response", async () => {
    let resolveSearch!: (value: Response) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise((resolve) => { resolveSearch = resolve; }));
    const view = render(<MemoryRouter><SearchModal open session={1} onClose={() => {}} /></MemoryRouter>);
    typeQuery("old query");
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    view.rerender(<MemoryRouter><SearchModal open={false} session={1} onClose={() => {}} /></MemoryRouter>);
    view.rerender(<MemoryRouter><SearchModal open session={2} onClose={() => {}} /></MemoryRouter>);
    expect(screen.getByRole("textbox")).toHaveValue("");
    resolveSearch(new Response(JSON.stringify({ q: "old query", exactOrderId: 42, users: [], products: [] })));
    await waitFor(() => expect(screen.queryByText("Order ORD-42")).not.toBeInTheDocument());
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("clears a failed search when its query is cleared without retrying an empty query", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    renderModal();
    typeQuery("steam");
    await screen.findByRole("alert");
    typeQuery("");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(/type to search across/i)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("distinguishes server failure from an empty search and retries the same query", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ q: "steam", exactOrderId: null, users: [], products: [] })));
    renderModal();
    typeQuery("steam");
    expect(await screen.findByRole("alert")).toHaveTextContent("Search could not be loaded");
    expect(screen.queryByText(/no results for/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry search" }));
    expect(await screen.findByText(/no results for/i)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("traps focus, keeps typing focused, and returns to the opener on Escape", async () => {
    mockSearchResponse({ q: "steam", exactOrderId: null, users: [], products: [] });
    function Harness() {
      const [open, setOpen] = useState(false);
      return <MemoryRouter>
        <button onClick={() => setOpen(true)}>Open search</button>
        <SearchModal open={open} onClose={() => setOpen(false)} />
      </MemoryRouter>;
    }
    const user = userEvent.setup();
    render(<StrictMode><Harness /></StrictMode>);
    await user.click(screen.getByText("Open search"));
    const input = screen.getByRole("textbox", { name: "Search orders, products, users" });
    expect(input).toHaveFocus();
    await user.type(input, "steam");
    expect(input).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByText("Open search")).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders a user hit and a product hit grouped under their type headers", async () => {
    mockSearchResponse({
      q: "steam",
      exactOrderId: null,
      users: [{ id: 1, username: "budi", fullName: "Budi Santoso", telegramId: "111222333" }],
      products: [{ id: 2, name: "50k", product: { name: "Steam Wallet" } }],
    });
    renderModal();
    typeQuery("steam");

    await waitFor(() => expect(screen.getByText("Budi Santoso")).toBeInTheDocument());
    expect(screen.getByText("Users")).toBeInTheDocument();
    expect(screen.getByText("@budi")).toBeInTheDocument();

    expect(screen.getByText("Products")).toBeInTheDocument();
    expect(screen.getByText("50k")).toBeInTheDocument();
    expect(screen.getByText("Steam Wallet")).toBeInTheDocument();
  });

  it("falls back through loginUsername/email and finally Customer #id when a storefront-only user has no fullName, username, or telegramId", async () => {
    mockSearchResponse({
      q: "cust",
      exactOrderId: null,
      users: [
        // Has a loginUsername to fall back on.
        { id: 7, username: null, fullName: null, telegramId: null, loginUsername: "shopper7", email: "shopper7@example.com" },
        // No identifying field at all — must still render a non-blank label.
        { id: 8, username: null, fullName: null, telegramId: null, loginUsername: null, email: null },
      ],
      products: [],
    });
    renderModal();
    typeQuery("cust");

    await waitFor(() => expect(screen.getByText("shopper7")).toBeInTheDocument());
    expect(screen.getByText("shopper7@example.com")).toBeInTheDocument();
    expect(screen.getByText("Customer #8")).toBeInTheDocument();
  });

  it("shows the exact order-code match grouped under Orders", async () => {
    mockSearchResponse({ q: "ORD-42", exactOrderId: 42, users: [], products: [] });
    renderModal();
    typeQuery("ORD-42");

    await waitFor(() => expect(screen.getByText("Order ORD-42")).toBeInTheDocument());
    expect(screen.getByText("Orders")).toBeInTheDocument();
  });

  it("shows the no-results empty state when nothing matches", async () => {
    mockSearchResponse({ q: "zzz", exactOrderId: null, users: [], products: [] });
    renderModal();
    typeQuery("zzz");

    await waitFor(() => expect(screen.getByText(/no results for/i)).toBeInTheDocument());
  });

  it("closes the modal on Escape", () => {
    const onClose = vi.fn();
    renderModal(onClose);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
