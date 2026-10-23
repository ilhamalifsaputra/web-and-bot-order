import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiGet, apiPut } from "../../api/client";
import type { TierState } from "../../lib/tierDraft";
import { TieredPricingCard } from "./TieredPricingCard";

vi.mock("../../api/client", () => ({ apiGet: vi.fn(), apiPut: vi.fn() }));

/** The 10000 base / 8000 from 3 / 6000 from 5 example, cost 7000. */
const EXAMPLE: TierState = {
  enabled: true,
  tiers: [
    { id: "t3", min_quantity: 3, discount_type: "FIXED_UNIT_PRICE", discount_value: "8000", is_enabled: true },
    { id: "t5", min_quantity: 5, discount_type: "FIXED_UNIT_PRICE", discount_value: "6000", is_enabled: true },
  ],
  base_unit_price: "10000",
  cost_price: "7000",
  analysis: { non_monotonic: [], below_cost: [] },
};

const EMPTY: TierState = { ...EXAMPLE, enabled: false, tiers: [], cost_price: null };

function renderCard(state: TierState, isGame = true) {
  vi.mocked(apiGet).mockResolvedValue(state);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  render(
    <QueryClientProvider client={qc}>
      <TieredPricingCard denominationId={10} productId="42" isGame={isGame} />
    </QueryClientProvider>,
  );
  return { qc, invalidate };
}

const tierRows = () => screen.getAllByRole("generic", { name: /^Tier \d+$/ });
const saveButton = () => screen.getByRole("button", { name: /simpan harga bertingkat/i });

beforeEach(() => {
  vi.mocked(apiGet).mockReset();
  vi.mocked(apiPut).mockReset();
});

describe("TieredPricingCard", () => {
  it("loads the SKU's tiers, shows the read-only base price row and each tier's final unit price", async () => {
    renderCard(EXAMPLE);
    expect(await screen.findByText("Harga dasar")).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith("/api/catalog/denominations/10/pricing-tiers");
    expect(screen.getByText("Rp10.000 / item")).toBeInTheDocument();
    expect(tierRows()).toHaveLength(2);
    expect(screen.getAllByTestId("tier-unit-price").map((el) => el.textContent)).toEqual(["Rp8.000", "Rp6.000"]);
    expect(screen.getByText("Hemat Rp2.000 per item")).toBeInTheDocument();
    // Nothing changed yet, so there is nothing to save.
    expect(saveButton()).toBeDisabled();
  });

  it.each([
    [1, "Harga dasar", "Rp10.000", "Rp10.000", "Rp0"],
    [2, "Harga dasar", "Rp10.000", "Rp20.000", "Rp0"],
    [3, "Mulai 3 item", "Rp8.000", "Rp24.000", "Rp6.000"],
    [4, "Mulai 3 item", "Rp8.000", "Rp32.000", "Rp8.000"],
    [5, "Mulai 5 item", "Rp6.000", "Rp30.000", "Rp20.000"],
    [6, "Mulai 5 item", "Rp6.000", "Rp36.000", "Rp24.000"],
  ])("simulates %i units: %s, %s each, %s total, saves %s", async (qty, tier, unit, total, savings) => {
    const user = userEvent.setup();
    renderCard(EXAMPLE);
    const input = await screen.findByLabelText("Simulasi: jumlah item");
    await user.clear(input);
    await user.type(input, String(qty));
    expect(screen.getByTestId("sim-tier")).toHaveTextContent(tier);
    expect(screen.getByTestId("sim-unit")).toHaveTextContent(unit);
    expect(screen.getByTestId("sim-total")).toHaveTextContent(total);
    expect(screen.getByTestId("sim-savings")).toHaveTextContent(savings);
  });

  it("warns (without blocking) that 5 units cost less than 4 and that 6.000 is below the 7.000 cost", async () => {
    const user = userEvent.setup();
    renderCard(EXAMPLE);
    await screen.findByText("Harga dasar");
    const warnings = screen.getAllByRole("status").filter((el) => el.getAttribute("data-slot") === "alert");
    expect(warnings.map((w) => within(w).getByText(/Total turun|Di bawah HPP/).textContent)).toEqual([
      "Total turun saat jumlah naik",
      "Di bawah HPP",
    ]);
    expect(warnings[0]).toHaveTextContent("4 item = Rp32.000, tetapi 5 item = Rp30.000");
    expect(warnings[1]).toHaveTextContent("Tier mulai 5 item: harga per item Rp6.000 di bawah HPP Rp7.000");
    // A warning never disables saving: an edit makes the form saveable as usual.
    await user.click(screen.getByRole("switch", { name: "Aktifkan harga bertingkat" }));
    expect(saveButton()).toBeEnabled();
  });

  it("adds a row one above the highest threshold and removes a row", async () => {
    const user = userEvent.setup();
    renderCard(EXAMPLE);
    await screen.findByText("Harga dasar");
    await user.click(screen.getByRole("button", { name: /tambah tier/i }));
    expect(tierRows()).toHaveLength(3);
    expect(within(tierRows()[2]!).getByLabelText("Mulai dari (item)")).toHaveValue("6");
    await user.click(screen.getByRole("button", { name: "Hapus tier 1" }));
    expect(tierRows()).toHaveLength(2);
    expect(tierRows().map((r) => (within(r).getByLabelText("Mulai dari (item)") as HTMLInputElement).value)).toEqual(["5", "6"]);
  });

  it("flags a duplicate threshold, an out-of-order one and an unreadable value inline, and blocks saving", async () => {
    const user = userEvent.setup();
    renderCard(EXAMPLE);
    await screen.findByText("Harga dasar");
    const second = within(tierRows()[1]!).getByLabelText("Mulai dari (item)");
    await user.clear(second);
    await user.type(second, "3");
    expect(screen.getByText("Jumlah 3 sudah dipakai tier lain.")).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();

    await user.clear(second);
    await user.type(second, "2");
    expect(screen.getByText("Urutkan dari jumlah terkecil: isi lebih dari 3.")).toBeInTheDocument();

    await user.clear(second);
    await user.type(second, "5");
    const value = within(tierRows()[1]!).getByLabelText("Harga per item (Rp)");
    await user.clear(value);
    await user.type(value, "1.2.3");
    expect(screen.getByText("Tulis nominal rupiah seperti 10000, 10.000 atau 10000,50.")).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });

  it("saves the toggle and the rows: typed 7.500 sent as typed, the untouched pre-fill named exact", async () => {
    const user = userEvent.setup();
    const saved: TierState = {
      ...EXAMPLE,
      enabled: false,
      tiers: [EXAMPLE.tiers[0]!, { ...EXAMPLE.tiers[1]!, discount_value: "7500" }],
    };
    vi.mocked(apiPut).mockResolvedValue(saved);
    const { invalidate } = renderCard(EXAMPLE);
    await screen.findByText("Harga dasar");
    await user.click(screen.getByRole("switch", { name: "Aktifkan harga bertingkat" }));
    const value = within(tierRows()[1]!).getByLabelText("Harga per item (Rp)");
    await user.clear(value);
    await user.type(value, "7.500");
    expect(screen.getAllByTestId("tier-unit-price")[1]).toHaveTextContent("Rp7.500");
    await user.click(saveButton());

    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1));
    expect(apiPut).toHaveBeenCalledWith("/api/catalog/denominations/10/pricing-tiers", {
      enabled: false,
      tiers: [
        { min_quantity: 3, discount_type: "FIXED_UNIT_PRICE", discount_value: "8000", is_enabled: true, exact_fields: ["discount_value"] },
        { min_quantity: 5, discount_type: "FIXED_UNIT_PRICE", discount_value: "7.500", is_enabled: true },
      ],
    });
    expect(await screen.findByText("Semua perubahan tersimpan.")).toBeInTheDocument();
    // The editor now holds the server's values, so they are untouched pre-fills again.
    expect(within(tierRows()[1]!).getByLabelText("Harga per item (Rp)")).toHaveValue("7500");
    expect(saveButton()).toBeDisabled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["catalog", "42"] });
  });

  it("shows the server's refusal next to the save button", async () => {
    const user = userEvent.setup();
    vi.mocked(apiPut).mockRejectedValue(new Error("Beberapa tier belum valid. Perbaiki baris yang ditandai lalu simpan lagi."));
    renderCard(EMPTY);
    await screen.findByRole("button", { name: /tambah tier/i });
    await user.click(screen.getByRole("button", { name: /tambah tier/i }));
    await user.type(within(tierRows()[0]!).getByLabelText("Diskon (%)"), "10");
    await user.click(saveButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("Beberapa tier belum valid");
  });

  it("with tiered pricing off, the simulator prices at the base price and says why", async () => {
    const user = userEvent.setup();
    renderCard({ ...EXAMPLE, enabled: false });
    const input = await screen.findByLabelText("Simulasi: jumlah item");
    await user.clear(input);
    await user.type(input, "5");
    expect(screen.getByTestId("sim-total")).toHaveTextContent("Rp50.000");
    expect(screen.getByText("Harga bertingkat nonaktif, jadi simulasi memakai harga dasar.")).toBeInTheDocument();
  });
});

describe("TieredPricingCard per product family", () => {
  it("Game Top Up counts items", async () => {
    renderCard(EXAMPLE, true);
    await screen.findByText("Harga dasar");
    expect(screen.getAllByLabelText("Mulai dari (item)")).toHaveLength(2);
    expect(screen.getByLabelText("Simulasi: jumlah item")).toBeInTheDocument();
    expect(screen.queryByText(/paket/)).not.toBeInTheDocument();
  });

  it("Premium Apps count packages and never show game wording (item, pcs, diamond, top up)", async () => {
    renderCard(EXAMPLE, false);
    await screen.findByText("Harga dasar");
    expect(screen.getAllByLabelText("Mulai dari (paket)")).toHaveLength(2);
    expect(screen.getByLabelText("Simulasi: jumlah paket")).toBeInTheDocument();
    expect(screen.getByText("Rp10.000 / paket")).toBeInTheDocument();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/\bitem\b|\bpcs\b|diamond|top.?up/i);
  });
});
