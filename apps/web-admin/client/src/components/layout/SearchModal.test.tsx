import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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
