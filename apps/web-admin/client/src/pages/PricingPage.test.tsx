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
  it("shows a Premium Apps row as manual pricing, with no Digiflazz count, rule badge or editor", async () => {
    renderPage(); await screen.findByRole("button", { name: /^edit\s*games$/i });
    const row = screen.getAllByRole("row").find(r => within(r).queryByText("Apps"))!;
    expect(within(row).getByText("Harga manual")).toBeInTheDocument();
    expect(within(row).queryByText(/SKU Digiflazz/)).not.toBeInTheDocument();
    expect(within(row).queryByText(/Inherited|Default global/)).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
  });
  it("N2: a non-game category whose Digiflazz SKUs the sync prices says so, never 'Harga manual'; a Game category keeps its rule cell", async () => {
    vi.mocked(apiGet).mockResolvedValue({ ...DATA, categories: [
      { id: 1, name: "Games", group: "GAME_TOPUP", markupType: null, markupValue: null, skuCount: 2, ruleReadable: true },
      { id: 3, name: "Legacy", group: null, markupType: null, markupValue: null, skuCount: 4, ruleReadable: true },
      { id: 4, name: "Old Apps", group: "PREMIUM_APPS", markupType: "percent", markupValue: "12", skuCount: 1, ruleReadable: true },
    ] });
    renderPage(); await screen.findByRole("button", { name: /^edit\s*games$/i });
    const rowOf = (name: string) => screen.getAllByRole("row").filter(r => within(r).queryAllByText(name).length > 0).at(-1)!;
    const legacy = rowOf("Legacy");
    expect(within(legacy).queryByText("Harga manual")).not.toBeInTheDocument();
    expect(within(legacy).getByText("Harga otomatis dari sync")).toBeInTheDocument();
    expect(within(legacy).getByText(/4 SKU Digiflazz/)).toBeInTheDocument();
    expect(within(legacy).getByText(/default global/)).toBeInTheDocument();
    expect(within(legacy).queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
    const old = rowOf("Old Apps");
    expect(within(old).getByText("Harga otomatis dari sync")).toBeInTheDocument();
    expect(within(old).getByText(/aturan lama tersimpan \(12%\)/)).toBeInTheDocument();
    expect(within(old).getByRole("button", { name: /^hapus\s*aturan\s*old apps$/i })).toBeInTheDocument();
    const games = rowOf("Games");
    expect(within(games).getByText("Default global")).toBeInTheDocument();
    expect(within(games).queryByText("Harga otomatis dari sync")).not.toBeInTheDocument();
  });
  it("N7: an unreadable Game category rule shows as 'Tidak terbaca', not as an override or the global default", async () => {
    vi.mocked(apiGet).mockResolvedValue({ ...DATA, categories: [
      { id: 1, name: "Games", group: "GAME_TOPUP", markupType: "weird", markupValue: "10", skuCount: 2, ruleReadable: false },
    ] });
    renderPage(); await screen.findByRole("button", { name: /^edit\s*games$/i });
    const row = screen.getAllByRole("row").filter(r => within(r).queryAllByText("Games").length > 0).at(-1)!;
    expect(within(row).getByText("Tidak terbaca")).toBeInTheDocument();
    expect(within(row).queryByText(/^Override$|^Inherited$|Default global/)).not.toBeInTheDocument();
    expect(within(row).getByRole("button", { name: /^hapus\s*aturan\s*games$/i })).toBeInTheDocument();
  });
  it("binds Apply now to the previewed policy and reports SKUs a price check blocked", async () => {
    const IMPACT = {
      eligibleCount: 3, changedCount: 1, policyFingerprint: "a".repeat(32),
      sample: [{ denominationId: 7, productName: "ML", name: "86 Diamonds", oldPrice: "20000", newPrice: "22000", cost: "20000" }],
      blockedCount: 1,
      blocked: [{ denominationId: 8, productName: "ML", name: "172 Diamonds", oldPrice: "115000", newPrice: "108000", cost: "100000", resellerPrice: "110000", reason: "reseller_above_price" }],
    };
    vi.mocked(apiPost).mockImplementation(async (path: string) =>
      path === "/api/pricing/reprice/preview" ? IMPACT
        : path === "/api/pricing/reprice/apply" ? { eligibleCount: 3, updatedCount: 1, unchangedCount: 1, skippedCount: 0, blockedCount: 1 }
        : path.endsWith("/preview") ? PREVIEW : {});
    renderPage(); await screen.findByText("Rp115.000");
    await userEvent.click(screen.getByRole("button", { name: "Lihat dampak & terapkan" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/1 SKU dilewati oleh Terapkan sekarang/)).toBeInTheDocument();
    // N3: the hourly sync does not run this check, so the dialog must not promise the price stays.
    expect(within(dialog).queryByText(/harganya tetap/)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/sync berikutnya masih dapat mengubah/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/172 Diamonds/)).toBeInTheDocument();
    expect(within(dialog).getByText(/di bawah harga reseller/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Terapkan sekarang" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/pricing/reprice/apply", { scope: "all", policyFingerprint: "a".repeat(32) }));
  });
  describe("M2: an Apply-now preview error shows next to its button, in Indonesian", () => {
    function rejectImpactWith(err: Error) {
      vi.mocked(apiPost).mockImplementation(async (path: string) => {
        if (path === "/api/pricing/reprice/preview") throw err;
        return path.endsWith("/preview") ? PREVIEW : {};
      });
    }
    async function clickImpact() {
      renderPage(); await screen.findByText("Rp115.000");
      const button = screen.getByRole("button", { name: "Lihat dampak & terapkan" });
      await userEvent.click(button);
      return button;
    }
    it("names the unreadable category inside the Apply card, directly above the button, and not at the top of the page", async () => {
      rejectImpactWith(Object.assign(new Error("The stored markup rule of category \"Voucher Game\" cannot be read, so no price can be computed from it."), {
        status: 400, errorArgs: { policy: "category", categories: "Voucher Game" },
      }));
      const button = await clickImpact();
      const card = document.getElementById("apply-pricing")!;
      const alert = await within(card).findByRole("alert");
      expect(alert).toHaveTextContent(/Tidak dapat menghitung dampak/);
      expect(alert).toHaveTextContent(/Voucher Game/);
      expect(alert).not.toHaveTextContent(/cannot be read/);
      expect(alert.querySelector("svg")).not.toBeNull();
      expect(alert.className).toContain("bg-rust-tint");
      // I1: rust-dark on rust-tint is 5.47:1 (rust is 4.08:1) — title/icon and description both.
      expect(alert.className).toContain("text-rust-dark");
      expect(alert.className).toContain("*:data-[slot=alert-description]:text-rust-dark");
      expect(alert.className).not.toContain("text-destructive");
      expect(alert.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(alert.nextElementSibling).toBe(button);
      // The only alert on the page is the one in the card.
      expect(screen.getAllByRole("alert")).toEqual([alert]);
    });
    it.each([
      [{ policy: "markup" }, /markup default/],
      [{ policy: "rounding" }, /pembulatan/],
    ])("words an unreadable global %j in Indonesian", async (errorArgs, text) => {
      rejectImpactWith(Object.assign(new Error("The stored default markup cannot be read"), { status: 400, errorArgs }));
      await clickImpact();
      const alert = await within(document.getElementById("apply-pricing")!).findByRole("alert");
      expect(alert).toHaveTextContent(text);
    });
    it("falls back to a generic Indonesian sentence for an unknown failure, and clears it on the next try", async () => {
      rejectImpactWith(new Error("/api/pricing/reprice/preview responded 500"));
      const button = await clickImpact();
      const alert = await within(document.getElementById("apply-pricing")!).findByRole("alert");
      expect(alert).toHaveTextContent("Tidak dapat menghitung dampak. Coba lagi sebentar lagi.");
      expect(alert).not.toHaveTextContent(/responded/);
      vi.mocked(apiPost).mockImplementation(async (path: string) => path === "/api/pricing/reprice/preview" ? new Promise(() => {}) : PREVIEW);
      await userEvent.click(button);
      await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    });
  });
  it("M3: lists SKUs left alone because their category rule is unreadable, and says so after applying", async () => {
    const IMPACT = {
      eligibleCount: 2, changedCount: 1, policyFingerprint: "b".repeat(32),
      sample: [{ denominationId: 7, productName: "ML", name: "86 Diamonds", oldPrice: "20000", newPrice: "23000", cost: "20000" }],
      blockedCount: 0, blocked: [],
      unreadableRuleCount: 1,
      unreadableRuleRows: [{ denominationId: 9, productName: "Free Fire", name: "140 Diamonds", categoryName: "Voucher Game", oldPrice: "21000", cost: "20000", reason: "category_rule_unreadable" }],
    };
    vi.mocked(apiPost).mockImplementation(async (path: string) =>
      path === "/api/pricing/reprice/preview" ? IMPACT
        : path === "/api/pricing/reprice/apply" ? { eligibleCount: 2, updatedCount: 1, unchangedCount: 0, skippedCount: 0, blockedCount: 0, unreadableRuleCount: 1 }
        : path.endsWith("/preview") ? PREVIEW : {});
    renderPage(); await screen.findByText("Rp115.000");
    await userEvent.click(screen.getByRole("button", { name: "Lihat dampak & terapkan" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/1 SKU dilewati karena aturan markup kategorinya tidak terbaca/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Free Fire · 140 Diamonds/)).toBeInTheDocument();
    expect(within(dialog).getByText(/kategori Voucher Game: aturan tidak terbaca/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Terapkan sekarang" }));
    expect(await screen.findByText(/1 SKU diperbarui; 1 SKU dilewati karena aturan kategorinya tidak terbaca\./)).toBeInTheDocument();
  });
  describe("M-1: an Apply-now failure on confirm reads in Indonesian", () => {
    const IMPACT = { eligibleCount: 1, changedCount: 1, policyFingerprint: "c".repeat(32), sample: [], blockedCount: 0, blocked: [], unreadableRuleCount: 0, unreadableRuleRows: [] };
    it.each([
      [Object.assign(new Error("The pricing rules changed after you opened the preview."), { status: 409, errorArgs: { conflict: "policy_changed" } }), /Aturan harga berubah setelah dampak diperiksa/],
      [Object.assign(new Error("A Digiflazz catalog sync or another reprice is running right now."), { status: 409, errorArgs: { conflict: "busy" } }), /Sync katalog Digiflazz atau penerapan lain sedang berjalan/],
      [Object.assign(new Error("The stored markup rule of category \"Voucher Game\" cannot be read"), { status: 400, errorArgs: { policy: "category", categories: "Voucher Game" } }), /Tidak dapat menerapkan harga\. Aturan markup tersimpan untuk kategori Voucher Game tidak terbaca/],
      [Object.assign(new Error("The new prices were applied to 3 item(s), but the change could not be written to the audit log."), { status: 500, errorArgs: { failure: "audit" } }), /Harga baru sudah diterapkan, tetapi catatan audit gagal disimpan/],
      [new Error("/api/pricing/reprice/apply responded 502"), /^Tidak dapat menerapkan harga\. Coba lagi sebentar lagi\.$/],
    ])("maps %s", async (err, text) => {
      vi.mocked(apiPost).mockImplementation(async (path: string) => {
        if (path === "/api/pricing/reprice/apply") throw err;
        return path === "/api/pricing/reprice/preview" ? IMPACT : PREVIEW;
      });
      renderPage(); await screen.findByText("Rp115.000");
      await userEvent.click(screen.getByRole("button", { name: "Lihat dampak & terapkan" }));
      const dialog = await screen.findByRole("dialog");
      await userEvent.click(within(dialog).getByRole("button", { name: "Terapkan sekarang" }));
      expect(await within(dialog).findByText(text)).toBeInTheDocument();
      expect(within(dialog).queryByText(err.message)).not.toBeInTheDocument();
    });
  });
  it("(b) the footer does not claim every Premium Apps price is manual", async () => {
    renderPage(); await screen.findByText("Rp115.000");
    expect(screen.queryByText(/Premium Apps menggunakan harga manual\./)).not.toBeInTheDocument();
    expect(screen.getByText(/Premium Apps memakai harga manual, kecuali SKU yang terhubung ke Digiflazz \(harganya mengikuti sync\)\./)).toBeInTheDocument();
  });
  it("(c) rule badges are outlined on the card background so they stay visible in the grey mobile card stack", async () => {
    renderPage(); await screen.findByRole("button", { name: /^edit\s*games$/i });
    for (const label of ["Inherited", "Harga manual"]) {
      for (const badge of screen.getAllByText(label)) {
        expect(badge).toHaveAttribute("data-variant", "outline");
        expect(badge.className).toContain("bg-card");
        // M-2: ink-soft at 80% is >= 3.5:1 against both the white badge and the bg-sand card.
        expect(badge.className).toContain("border-ink-soft/80");
        expect(badge.className).not.toContain("border-border");
      }
    }
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
