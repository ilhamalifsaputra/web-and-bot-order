import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiGet, apiPost } from "../api/client";
import HelpPage from "./HelpPage";

vi.mock("../api/client", () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
const options = { categories: [{ key: "ORDER", issues: ["not_received", "other"], order: true }, { key: "ACCOUNT", issues: ["login", "other"], order: false }], media: { enabled: false } };
const empty = { tickets: [], total: 0, page: 1, page_size: 10 };
function show(url = "/help") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><Routes><Route path="/help" element={<HelpPage />} /><Route path="/account/support/:id" element={<p>Ticket detail opened</p>} /></Routes></MemoryRouter></QueryClientProvider>);
}
beforeEach(() => {
  document.documentElement.lang = "en";
  vi.clearAllMocks();
  vi.mocked(apiGet).mockImplementation(async (path) => path.endsWith("/options") ? options : path.endsWith("/orders") ? { orders: [{ code: "ORD-OWNED", items: "Premium plan" }] } : empty);
  vi.mocked(apiPost).mockResolvedValue({ ticket_id: 7 });
});
describe("unified compact help center", () => {
  it("shows one dynamic form and history without manual subject or product fields", async () => {
    show();
    await waitFor(() => expect(screen.getByLabelText(/Help category/)).toBeEnabled());
    expect(screen.queryByLabelText(/Subject/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Product/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Player ID/)).not.toBeInTheDocument();
  });
  it("shows order context only for an applicable category and clears it on category switching", async () => {
    show("/help?order=ORD-OWNED");
    const order = await screen.findByLabelText(/Related order/);
    expect(order).toHaveValue("ORD-OWNED");
    fireEvent.change(screen.getByLabelText(/Help category/), { target: { value: "ACCOUNT" } });
    expect(screen.queryByLabelText(/Related order/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Help category/), { target: { value: "ORDER" } });
    expect(screen.getByLabelText(/Related order/)).toHaveValue("");
  });
  it("submits stable keys without stale order or game-only data", async () => {
    show("/help?order=ORD-OWNED");
    await screen.findByLabelText(/Related order/);
    fireEvent.change(screen.getByLabelText(/Help category/), { target: { value: "ACCOUNT" } });
    fireEvent.change(screen.getByLabelText(/Issue/), { target: { value: "login" } });
    fireEvent.change(screen.getByLabelText(/Describe the issue/), { target: { value: "Cannot sign into my account" } });
    fireEvent.click(screen.getByRole("button", { name: "Send Ticket" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/account/support/v2", { category: "ACCOUNT", issue: "login", description: "Cannot sign into my account", order_code: undefined, request_id: expect.any(String), attachment_ids: [] }));
    expect(await screen.findByText("Ticket detail opened")).toBeInTheDocument();
  });
  it("blocks low-quality descriptions and focuses the field", async () => {
    show(); await waitFor(() => expect(screen.getByLabelText(/Help category/)).toBeEnabled());
    fireEvent.change(screen.getByLabelText(/Describe the issue/), { target: { value: "hi" } });
    fireEvent.submit(screen.getByRole("button", { name: "Send Ticket" }).closest("form")!);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Describe the issue/)).toHaveFocus();
  });
  it("keeps the same idempotency key when a failed submission is retried", async () => {
    vi.mocked(apiPost).mockRejectedValue(new Error("Offline"));
    show(); await waitFor(() => expect(screen.getByLabelText(/Help category/)).toBeEnabled());
    fireEvent.change(screen.getByLabelText(/Help category/), { target: { value: "ACCOUNT" } });
    fireEvent.change(screen.getByLabelText(/Issue/), { target: { value: "login" } });
    fireEvent.change(screen.getByLabelText(/Describe the issue/), { target: { value: "Cannot sign into my account" } });
    fireEvent.click(screen.getByRole("button", { name: "Send Ticket" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Send Ticket" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2));
    expect(vi.mocked(apiPost).mock.calls[0]![1]).toEqual(vi.mocked(apiPost).mock.calls[1]![1]);
  });
  it("offers all workflow filters and fetches the selected status", async () => {
    show();
    const filter = await screen.findByLabelText("Filter ticket status");
    expect(filter.querySelectorAll("option")).toHaveLength(6);
    fireEvent.change(filter, { target: { value: "in_progress" } });
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringContaining("status=in_progress")));
  });
  it("retains a legacy ticket link by opening the canonical detail", async () => {
    show("/help?ticket=27");
    expect(await screen.findByText("Ticket detail opened")).toBeInTheDocument();
    expect(apiGet).not.toHaveBeenCalled();
  });
});
