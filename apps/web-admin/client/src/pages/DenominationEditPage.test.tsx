import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DenominationEditPage } from "./DenominationEditPage";
import { apiGet, apiPatch } from "../api/client";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
  apiPatch: vi.fn(),
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
        warrantyDays: 30,
        description: "Shared profile",
        sortOrder: 5,
        deliveryType: "auto",
      }),
    );
    await waitFor(() => expect(screen.getByText("product-detail-page")).toBeInTheDocument());
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
