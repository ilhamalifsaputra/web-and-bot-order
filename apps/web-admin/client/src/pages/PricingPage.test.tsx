import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PricingPage } from "./PricingPage";
import { apiGet, apiPost, apiPut, apiDelete } from "../api/client";
vi.mock("../api/client", () => ({ apiGet: vi.fn(), apiPost: vi.fn(), apiPut: vi.fn(), apiDelete: vi.fn() }));
const DATA = { isOwner: true, policy: { globalRule: { type: "percent", value: "15" }, globalRuleReadable: true, roundingReadable: true, rounding: "none", lowMarginWarnPct: null }, categories: [
  { id: 1, name: "Games", group: "GAME_TOPUP", markupType: null, markupValue: null, skuCount: 2 },
  { id: 2, name: "Apps", group: "PREMIUM_APPS", markupType: null, markupValue: null, skuCount: 0 },
] };
const PREVIEW = { rows: [{ costPrice: "100000", effectivePrice: "115000", grossProfit: "15000", grossMarginPct: "13.04347826" }] };
function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}><PricingPage /></QueryClientProvider></MemoryRouter>);
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(apiGet).mockResolvedValue(DATA);
  vi.mocked(apiPost).mockImplementation(async path => path.endsWith("/preview") ? PREVIEW : {});
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});
describe("PricingPage", () => {
  it("shows server preview, saves a dirty policy after confirmation, and reloads", async () => {
    renderPage();
    await screen.findByText("Rp115.000");
    expect(screen.getByRole("button", { name: "Simpan default" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Markup (%)"), { target: { value: "20" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Simpan default" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Simpan default" }));
    vi.mocked(apiGet).mockResolvedValue({ ...DATA, policy: { ...DATA.policy, globalRule: { type: "percent", value: "20" } } });
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/pricing/global", expect.objectContaining({ markupType: "percent", markupValue: "20" })));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
  });
  it("changes percent/flat units and blocks invalid drafts", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPage(); await screen.findByText("Rp115.000");
    await user.click(screen.getByRole("combobox", { name: "Jenis markup" }));
    await user.click(screen.getByRole("option", { name: "Nominal tetap (IDR)" }));
    expect(screen.getByLabelText("Markup (IDR)")).toBeInTheDocument();
    vi.mocked(apiPost).mockRejectedValue(new Error("Enter a valid markup amount."));
    fireEvent.change(screen.getByLabelText("Markup (IDR)"), { target: { value: "bad" } });
    await screen.findByText("Enter a valid markup amount.");
    expect(screen.getByRole("button", { name: "Simpan default" })).toBeDisabled();
  });
  it("ignores stale preview responses and aborts superseded requests", async () => {
    let resolveOld!: (value: unknown) => void;
    vi.mocked(apiPost).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    renderPage();
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    const signal = vi.mocked(apiPost).mock.calls[0]![2]!.signal!;
    fireEvent.change(screen.getByLabelText("Markup (%)"), { target: { value: "20" } });
    await screen.findByText("Rp115.000");
    expect(signal.aborted).toBe(true);
    await act(async () => resolveOld({ rows: [{ ...PREVIEW.rows[0], effectivePrice: "999" }] }));
    expect(screen.queryByText("Rp999")).not.toBeInTheDocument();
    expect(screen.getByText("Rp115.000")).toBeInTheDocument();
  });
  it("makes non-owner access read-only and keeps Premium Apps manual", async () => {
    vi.mocked(apiGet).mockResolvedValue({ ...DATA, isOwner: false });
    renderPage();
    await screen.findByText(/Akses baca saja/);
    expect(screen.getByRole("button", { name: "Simpan default" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Edit Apps" })).not.toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
  });
  it("saves and removes category overrides", async () => {
    renderPage(); await screen.findByRole("button", { name: /^edit\s*games$/i });
    await userEvent.click(screen.getByRole("button", { name: /^edit\s*games$/i }));
    fireEvent.change(screen.getByLabelText("Markup (%)", { selector: "#category-markup" }), { target: { value: "8" } });
    vi.mocked(apiPut).mockResolvedValue({ changed: true });
    vi.mocked(apiGet).mockResolvedValue({ ...DATA, categories: [{ ...DATA.categories[0], markupType: "percent", markupValue: "8" }] });
    await userEvent.click(screen.getByRole("button", { name: "Simpan aturan" }));
    await waitFor(() => expect(apiPut).toHaveBeenCalledWith("/api/pricing/categories/1", expect.objectContaining({ markupValue: "8" })));
    await userEvent.click(await screen.findByRole("button", { name: /^hapus\s*aturan\s*games$/i }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(apiDelete).toHaveBeenCalledWith("/api/pricing/categories/1"));
  });
});
