import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DenominationEditPage } from "./DenominationEditPage";
import { apiGet, apiPatch, apiPost, apiDelete } from "../api/client";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
  apiPatch: vi.fn(),
  apiPost: vi.fn(),
  apiDelete: vi.fn(),
}));

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={["/catalog/42/denominations/10/edit"]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/catalog/:productId/denominations/:denomId/edit" element={children} />
          <Route path="/catalog/:productId" element={<div>product-detail-page</div>} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const PRODUCT_DETAIL = {
  product: {
    id: 42,
    name: "Netflix Premium",
    denominations: [
      {
        id: 10,
        name: "Netflix 1 Month",
        type: "SHARED",
        durationLabel: "1 Month",
        price: "15000",
        costPrice: "10000",
        resellerPrice: null,
        warrantyDays: 30,
        description: "Shared profile",
        sortOrder: 5,
        deliveryType: "auto",
        additionalFields: null,
      },
    ],
  },
};

const MANUAL_WITH_INFO_FIELDS = [
  { key: "ign", label: { id: "IGN", en: "IGN" }, type: "text", required: true, options: [], placeholder: "" },
];

const MANUAL_WITH_INFO_PRODUCT_DETAIL = {
  product: {
    id: 42,
    name: "Netflix Premium",
    denominations: [
      {
        ...PRODUCT_DETAIL.product.denominations[0],
        deliveryType: "manual_with_info",
        additionalFields: JSON.stringify(MANUAL_WITH_INFO_FIELDS),
      },
    ],
  },
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(apiGet).mockReset();
  vi.mocked(apiPatch).mockReset();
  vi.mocked(apiPost).mockReset();
  vi.mocked(apiDelete).mockReset();
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("DenominationEditPage", () => {
  it("shows the real product name in the breadcrumb, not the literal word 'Product' (F-007)", async () => {
    vi.mocked(apiGet).mockResolvedValue(PRODUCT_DETAIL);
    render(<DenominationEditPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByRole("link", { name: "Netflix Premium" })).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: "Product" })).not.toBeInTheDocument();
  });

  // Task 6: same "(IDR)" disambiguation as DenominationCreatePage — the
  // display-currency preference is now per-user, so a bare "Price" label is
  // ambiguous about which currency the admin is editing in.
  it("labels every price-type input with its currency (IDR) — Price, Cost Price, Reseller Price", async () => {
    vi.mocked(apiGet).mockResolvedValue(PRODUCT_DETAIL);
    render(<DenominationEditPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByDisplayValue("Netflix 1 Month")).toBeInTheDocument());

    function label(text: string): HTMLElement {
      return screen.getByText(
        (_content, element) => element?.tagName.toLowerCase() === "label" && (element.textContent ?? "").startsWith(text),
      );
    }
    expect(label("Price (IDR)")).toBeInTheDocument();
    expect(label("Cost Price (IDR)")).toBeInTheDocument();
    expect(label("Reseller Price (IDR)")).toBeInTheDocument();
  });

  it("prefills the form from the existing denomination", async () => {
    vi.mocked(apiGet).mockResolvedValue(PRODUCT_DETAIL);
    render(<DenominationEditPage />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByDisplayValue("Netflix 1 Month")).toBeInTheDocument());
    expect(screen.getByDisplayValue("15000")).toBeInTheDocument();
    expect(screen.getByDisplayValue("10000")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save changes/i })).toBeInTheDocument();
  });

  it("prefills the Delivery Type radios from the loaded denomination (plain Manual, no buyer info required)", async () => {
    vi.mocked(apiGet).mockResolvedValue({
      product: {
        id: 42,
        name: "Netflix Premium",
        denominations: [{ ...PRODUCT_DETAIL.product.denominations[0], deliveryType: "manual" }],
      },
    });
    render(<DenominationEditPage />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByDisplayValue("Netflix 1 Month")).toBeInTheDocument());
    expect(screen.getByRole("radio", { name: /^manual delivery/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: /^automatic delivery/i })).not.toBeChecked();
    // Step 2 (Buyer Information) is visible once Manual is loaded, defaulted
    // to "no info required" — Step 3 (the field editor) stays hidden.
    expect(screen.getByRole("radio", { name: /^no buyer information required/i })).toBeChecked();
    expect(screen.queryByRole("button", { name: /add field/i })).not.toBeInTheDocument();
  });

  it("prefills the field editor from the loaded additionalFields JSON when deliveryType is manual_with_info", async () => {
    vi.mocked(apiGet).mockResolvedValue(MANUAL_WITH_INFO_PRODUCT_DETAIL);
    render(<DenominationEditPage />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByDisplayValue("Netflix 1 Month")).toBeInTheDocument());
    expect(screen.getByRole("radio", { name: /^manual delivery/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: /^require buyer information/i })).toBeChecked();
    expect(screen.getAllByDisplayValue("IGN")).toHaveLength(2);
  });

  it("submits the edited fields via PATCH and navigates back to the product detail page", async () => {
    vi.mocked(apiGet).mockResolvedValue(PRODUCT_DETAIL);
    vi.mocked(apiPatch).mockResolvedValueOnce({ id: 10, name: "Netflix 1 Month Plan" });
    render(<DenominationEditPage />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByDisplayValue("Netflix 1 Month")).toBeInTheDocument());
    fireEvent.change(screen.getByDisplayValue("Netflix 1 Month"), { target: { value: "Netflix 1 Month Plan" } });

    const btn = screen.getByRole("button", { name: /save changes/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);

    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith("/api/catalog/denominations/10", {
        name: "Netflix 1 Month Plan",
        type: "SHARED",
        durationLabel: "1 Month",
        price: "15000",
        costPrice: "10000",
        // Both prices are untouched pre-fills: the server reads them as plain
        // decimals instead of by shape (lib/exactFields.ts).
        exact_fields: ["price", "costPrice"],
        warrantyDays: 30,
        description: "Shared profile",
        sortOrder: 5,
        deliveryType: "auto",
        // Task 7: nicknameCheckGameCode is always sent on an edit (unlike
        // create) — see DenominationEditPage.tsx's submit payload — so an
        // admin can clear a previously-set value by blanking the field, not
        // just set one. This fixture never touched the field, so it's null.
        nicknameCheckGameCode: null,
        // Task 14: qtyValue/qtyUnit follow the same always-sent-on-edit
        // convention — this fixture never touched them, so both are null.
        qtyValue: null,
        qtyUnit: null,
      }),
    );
    await waitFor(() => expect(screen.getByText("product-detail-page")).toBeInTheDocument());
  });

  // A stored 100.123 is pre-filled as the server's own plain decimal; saving
  // an unrelated change must mark it exact so the server doesn't read it as
  // 100123. A retyped price is left out and read by shape.
  it("marks untouched pre-filled prices exact and leaves a retyped one out", async () => {
    vi.mocked(apiGet).mockResolvedValue({
      product: {
        id: 42,
        name: "Netflix Premium",
        denominations: [{ ...PRODUCT_DETAIL.product.denominations[0], price: "100.123", costPrice: "90.5", resellerPrice: "95.125" }],
      },
    });
    vi.mocked(apiPatch).mockResolvedValueOnce({ id: 10, name: "Netflix 1 Month" });
    render(<DenominationEditPage />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByDisplayValue("100.123")).toBeInTheDocument());
    fireEvent.change(screen.getByDisplayValue("90.5"), { target: { value: "90.000" } });
    const btn = screen.getByRole("button", { name: /save changes/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);

    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith(
        "/api/catalog/denominations/10",
        expect.objectContaining({ price: "100.123", costPrice: "90.000", resellerPrice: "95.125", exact_fields: ["price", "resellerPrice"] }),
      ),
    );
  });

  // Task 14: qtyValue/qtyUnit round-trip through prefill and submit.
  it("prefills qtyValue/qtyUnit from the loaded denomination and submits them", async () => {
    vi.mocked(apiGet).mockResolvedValue({
      product: {
        id: 42,
        name: "Netflix Premium",
        denominations: [{ ...PRODUCT_DETAIL.product.denominations[0], qtyValue: 86, qtyUnit: "Diamonds" }],
      },
    });
    vi.mocked(apiPatch).mockResolvedValueOnce({ id: 10, name: "Netflix 1 Month" });
    render(<DenominationEditPage />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByDisplayValue("Netflix 1 Month")).toBeInTheDocument());
    expect(screen.getByDisplayValue("86")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Diamonds")).toBeInTheDocument();

    const btn = screen.getByRole("button", { name: /save changes/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);

    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith(
        "/api/catalog/denominations/10",
        expect.objectContaining({ qtyValue: 86, qtyUnit: "Diamonds" }),
      ),
    );
  });

  it("submits a manual_with_info edit with the prefilled additionalFields as a raw array (not a JSON string)", async () => {
    // Regression test: DenominationEditPage previously JSON.stringify()d
    // additionalFields before handing it to apiPatch, which itself
    // JSON.stringify()s the whole outer body for the actual fetch call —
    // double-encoding the field into a string. The server route expects a
    // raw array (zAdditionalFields = z.array(...)) and rejects a string, so
    // every real save of a manual_with_info denomination failed with a 400
    // even though this half's mocked apiPatch never caught it.
    vi.mocked(apiGet).mockResolvedValue(MANUAL_WITH_INFO_PRODUCT_DETAIL);
    vi.mocked(apiPatch).mockResolvedValueOnce({ id: 10, name: "Netflix 1 Month" });
    render(<DenominationEditPage />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByDisplayValue("Netflix 1 Month")).toBeInTheDocument());
    const btn = screen.getByRole("button", { name: /save changes/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);

    await waitFor(() => expect(apiPatch).toHaveBeenCalledTimes(1));
    const [, sentBody] = vi.mocked(apiPatch).mock.calls[0] as [string, Record<string, unknown>];
    expect(Array.isArray(sentBody.additionalFields)).toBe(true);
    expect(apiPatch).toHaveBeenCalledWith(
      "/api/catalog/denominations/10",
      expect.objectContaining({
        deliveryType: "manual_with_info",
        additionalFields: MANUAL_WITH_INFO_FIELDS,
      }),
    );
  });

  it("switching Delivery Type away from 'Manual + buyer info required' drops autoDeliverySource/supplierSku from the submitted payload", async () => {
    // Regression coverage for the client half of the fix in 024fec6: the
    // backend routes independently re-derive/strip autoDeliverySource and
    // supplierSku when deliveryType isn't manual_with_info, so this isn't a
    // live data-integrity bug — but DeliveryTypeSection's selectMethod
    // handler is what's supposed to reset this state on the client, and
    // nothing exercised it before this test.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiGet).mockResolvedValue({
      product: {
        id: 42,
        name: "Netflix Premium",
        denominations: [
          {
            ...PRODUCT_DETAIL.product.denominations[0],
            deliveryType: "manual_with_info",
            additionalFields: JSON.stringify(MANUAL_WITH_INFO_FIELDS),
            autoDeliverySource: "digiflazz",
            supplierSku: "mlbb86",
          },
        ],
      },
    });
    vi.mocked(apiPatch).mockResolvedValueOnce({ id: 10, name: "Netflix 1 Month" });
    render(<DenominationEditPage />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByDisplayValue("Netflix 1 Month")).toBeInTheDocument());
    // Sanity check the fixture actually prefilled Step 4 with Digiflazz.
    expect(screen.getByRole("radio", { name: /^digiflazz/i })).toBeChecked();
    expect(screen.getByDisplayValue("mlbb86")).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /^automatic delivery/i }));
    // Step 4 (and Steps 2/3) are gone now that deliveryType is back to "auto".
    expect(screen.queryByRole("radio", { name: /^digiflazz/i })).not.toBeInTheDocument();

    const btn = screen.getByRole("button", { name: /save changes/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);

    await waitFor(() => expect(apiPatch).toHaveBeenCalledTimes(1));
    const [, sentBody] = vi.mocked(apiPatch).mock.calls[0] as [string, Record<string, unknown>];
    expect(sentBody).not.toHaveProperty("autoDeliverySource");
    expect(sentBody).not.toHaveProperty("supplierSku");
    expect(sentBody).not.toHaveProperty("additionalFields");
    expect(sentBody.deliveryType).toBe("auto");
  });

  it("changing Delivery Type to Manual -> Require buyer information requires at least one field before saving", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiGet).mockResolvedValue(PRODUCT_DETAIL);
    render(<DenominationEditPage />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByDisplayValue("Netflix 1 Month")).toBeInTheDocument());
    const btn = screen.getByRole("button", { name: /save changes/i });
    await waitFor(() => expect(btn).not.toBeDisabled());

    await user.click(screen.getByRole("radio", { name: /^manual delivery/i }));
    expect(btn).not.toBeDisabled(); // Step 2 defaults to "no info required" — still submittable.

    await user.click(screen.getByRole("radio", { name: /^require buyer information/i }));
    expect(btn).toBeDisabled();
  });

  it("shows an error message when saving fails", async () => {
    vi.mocked(apiGet).mockResolvedValue(PRODUCT_DETAIL);
    vi.mocked(apiPatch).mockRejectedValueOnce(new Error("A valid type is required."));
    render(<DenominationEditPage />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByDisplayValue("Netflix 1 Month")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(screen.getByText(/a valid type is required/i)).toBeInTheDocument());
  });
});

describe("DenominationEditPage Telegram button hints", () => {
  const withGroup = (group: string) => ({ product: { ...PRODUCT_DETAIL.product, category: { id: 3, name: "Cat", group } } });

  it("Game Top Up: hints Name and Quantity Unit", async () => {
    vi.mocked(apiGet).mockResolvedValue(withGroup("GAME_TOPUP"));
    render(<DenominationEditPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByDisplayValue("Netflix 1 Month")).toBeInTheDocument());
    // "Netflix 1 Month" is 15 cells; the Quantity Unit starts empty.
    expect(screen.getAllByTestId("button-label-counter").map((el) => el.textContent)).toEqual(["15/24", "0/16"]);
  });

  it("Game Top Up: tells that Duration Label only reaches the button when it differs from the Name", async () => {
    vi.mocked(apiGet).mockResolvedValue(withGroup("GAME_TOPUP"));
    render(<DenominationEditPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByDisplayValue("Netflix 1 Month")).toBeInTheDocument());
    expect(screen.getByTestId("duration-label-game-hint")).toHaveTextContent(/only when it differs from the name/i);
  });

  it("Game Top Up: does not count the game name at the start of the Name", async () => {
    vi.mocked(apiGet).mockResolvedValue(withGroup("GAME_TOPUP"));
    render(<DenominationEditPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByDisplayValue("Netflix 1 Month")).toBeInTheDocument());
    fireEvent.change(screen.getByDisplayValue("Netflix 1 Month"), { target: { value: "netflix premium Family 1 Month" } });
    // "Family 1 Month" is 14 cells once the product's name "Netflix Premium" is dropped.
    expect(screen.getAllByTestId("button-label-counter").map((el) => el.textContent)).toEqual(["14/24", "0/16"]);
  });

  it("Game Top Up: a SKU with quantity and unit shows the note, not a Name counter", async () => {
    const detail = withGroup("GAME_TOPUP");
    vi.mocked(apiGet).mockResolvedValue({ product: { ...detail.product, denominations: [{ ...detail.product.denominations[0], qtyValue: 86, qtyUnit: "Diamonds" }] } });
    render(<DenominationEditPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByDisplayValue("Netflix 1 Month")).toBeInTheDocument());
    expect(screen.getAllByTestId("button-label-counter").map((el) => el.textContent)).toEqual(["8/16"]);
    expect(screen.getByTestId("button-label-note")).toBeInTheDocument();
  });

  it("Premium Apps: hints Duration Label and still saves an over-budget label", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiGet).mockResolvedValue(withGroup("PREMIUM_APPS"));
    vi.mocked(apiPatch).mockResolvedValue({ ok: true });
    render(<DenominationEditPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByDisplayValue("1 Month")).toBeInTheDocument());
    expect(screen.getAllByTestId("button-label-counter").map((el) => el.textContent)).toEqual(["7/18"]);
    const long = "1 Month Family Plan With Extras";
    fireEvent.change(screen.getByDisplayValue("1 Month"), { target: { value: long } });
    expect(screen.getByTestId("button-label-counter")).toHaveAttribute("data-state", "over");
    await user.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ durationLabel: long })));
  });
});
