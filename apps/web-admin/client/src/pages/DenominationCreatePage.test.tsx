import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DenominationCreatePage } from "./DenominationCreatePage";
import { apiGet, apiPost } from "../api/client";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={["/catalog/42/denominations/new"]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/catalog/:productId/denominations/new" element={children} />
          <Route path="/catalog/:productId" element={<div>product-detail-page</div>} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  // F-007: breadcrumb fetches the product name via apiGet — give every test
  // a sane default so tests that don't care about the breadcrumb don't hit
  // an unconfigured mock.
  vi.mocked(apiGet).mockResolvedValue({ product: { id: 42, name: "Netflix Premium" } });
  // Radix Select uses pointer-capture APIs and scrollIntoView — jsdom doesn't
  // implement them. Mock all three to prevent unhandled errors when the
  // dropdown opens and focuses the first option.
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

/** Fills name/type/duration/price — the fields required regardless of
 * delivery type — leaving deliveryType at its default (Auto). */
async function fillBaseFields(user: ReturnType<typeof userEvent.setup>) {
  fireEvent.change(screen.getByPlaceholderText(/^e\.g\. netflix premium$/i), { target: { value: "1 Month Plan" } });
  await user.click(screen.getByRole("combobox", { name: "Account Type" }));
  await waitFor(() => screen.getByRole("option", { name: "Shared" }));
  await user.click(screen.getByRole("option", { name: "Shared" }));
  fireEvent.change(screen.getByPlaceholderText(/1 month/i), { target: { value: "1 Month" } });
  fireEvent.change(screen.getByPlaceholderText(/15000/i), { target: { value: "15000" } });
}

describe("DenominationCreatePage", () => {
  it("shows the real product name in the breadcrumb, not the literal word 'Product' (F-007)", async () => {
    render(<DenominationCreatePage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByRole("link", { name: "Netflix Premium" })).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: "Product" })).not.toBeInTheDocument();
  });

  it("falls back to the product id in the breadcrumb while the product name is still loading", () => {
    vi.mocked(apiGet).mockReturnValue(new Promise(() => {})); // never resolves
    render(<DenominationCreatePage />, { wrapper: Wrapper });
    expect(screen.getByRole("link", { name: "Product #42" })).toBeInTheDocument();
  });

  it("renders name, price, and duration inputs and a submit button", () => {
    render(<DenominationCreatePage />, { wrapper: Wrapper });
    expect(screen.getByPlaceholderText(/1 month/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/15000/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create denomination/i })).toBeInTheDocument();
  });

  // Task 6: admin stays IDR-native, but with USD/IDR display now a real
  // per-user choice, these bare "Price"/"Cost Price"/"Reseller Price" labels
  // are ambiguous about which currency the admin is typing in.
  it("labels every price-type input with its currency (IDR) — Price, Cost Price, Reseller Price", () => {
    render(<DenominationCreatePage />, { wrapper: Wrapper });
    function label(text: string): HTMLElement {
      return screen.getByText(
        (_content, element) => element?.tagName.toLowerCase() === "label" && (element.textContent ?? "").startsWith(text),
      );
    }
    expect(label("Price (IDR)")).toBeInTheDocument();
    expect(label("Cost Price (IDR)")).toBeInTheDocument();
    expect(label("Reseller Price (IDR)")).toBeInTheDocument();
  });

  it("renders Delivery Type as two radio options defaulting to Automatic Delivery", () => {
    render(<DenominationCreatePage />, { wrapper: Wrapper });
    expect(screen.getByRole("radio", { name: /^automatic delivery/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: /^manual delivery/i })).not.toBeChecked();
    // Steps 2/3 (Buyer Information / Buyer Information Fields) only appear
    // once Manual Delivery is chosen — progressive disclosure.
    expect(screen.queryByRole("radio", { name: /^require buyer information/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add field/i })).not.toBeInTheDocument();
  });

  it("submit button is disabled until name, type, duration, and a valid price are set", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<DenominationCreatePage />, { wrapper: Wrapper });

    const btn = screen.getByRole("button", { name: /create denomination/i });
    expect(btn).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/^e\.g\. netflix premium$/i), { target: { value: "1 Month Plan" } });
    expect(btn).toBeDisabled();

    await user.click(screen.getByRole("combobox", { name: "Account Type" }));
    await waitFor(() => screen.getByRole("option", { name: "Shared" }));
    await user.click(screen.getByRole("option", { name: "Shared" }));
    expect(btn).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/1 month/i), { target: { value: "1 Month" } });
    expect(btn).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/15000/i), { target: { value: "not-a-number" } });
    expect(btn).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/15000/i), { target: { value: "15000" } });
    expect(btn).not.toBeDisabled();
  });

  it("selecting Manual Delivery reveals Buyer Information (Step 2) without yet requiring fields", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<DenominationCreatePage />, { wrapper: Wrapper });
    await fillBaseFields(user);

    const btn = screen.getByRole("button", { name: /create denomination/i });
    await waitFor(() => expect(btn).not.toBeDisabled());

    await user.click(screen.getByRole("radio", { name: /^manual delivery/i }));

    // Step 2 appears, defaulting to "no info required" — Step 3 (the field
    // editor) stays hidden and submit stays enabled until the seller
    // explicitly opts into requiring buyer information.
    expect(screen.getByRole("radio", { name: /^no buyer information required/i })).toBeChecked();
    expect(screen.queryByRole("button", { name: /add field/i })).not.toBeInTheDocument();
    expect(btn).not.toBeDisabled();
  });

  it("Manual Delivery -> Require buyer information reveals the field editor and requires a fully-valid field before submitting", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<DenominationCreatePage />, { wrapper: Wrapper });
    await fillBaseFields(user);

    const btn = screen.getByRole("button", { name: /create denomination/i });
    await waitFor(() => expect(btn).not.toBeDisabled());

    await user.click(screen.getByRole("radio", { name: /^manual delivery/i }));
    await user.click(screen.getByRole("radio", { name: /^require buyer information/i }));

    expect(screen.getByRole("button", { name: /add field/i })).toBeInTheDocument();
    expect(btn).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /add field/i }));
    expect(btn).toBeDisabled();

    // One question alone isn't enough — fieldsAreValid mirrors the server's
    // real requirements (both bilingual labels, select needs options), so a
    // half-filled row must keep the button disabled rather than let the
    // admin hit the server's generic rejection message.
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. id game/i), { target: { value: "IGN" } });
    expect(btn).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/e\.g\. game id/i), { target: { value: "IGN" } });
    expect(btn).not.toBeDisabled();
  });

  it("switching back to Automatic Delivery hides Buyer Information and the field editor entirely", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<DenominationCreatePage />, { wrapper: Wrapper });
    await fillBaseFields(user);

    await user.click(screen.getByRole("radio", { name: /^manual delivery/i }));
    await user.click(screen.getByRole("radio", { name: /^require buyer information/i }));
    expect(screen.getByRole("button", { name: /add field/i })).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /^automatic delivery/i }));
    expect(screen.queryByRole("radio", { name: /^require buyer information/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add field/i })).not.toBeInTheDocument();

    // Submit is unblocked again — Automatic Delivery never needs fields.
    const btn = screen.getByRole("button", { name: /create denomination/i });
    expect(btn).not.toBeDisabled();
  });

  it("switching Manual -> Automatic -> Manual resets Buyer Information to its default (no hidden memory across delivery methods)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<DenominationCreatePage />, { wrapper: Wrapper });
    await fillBaseFields(user);

    await user.click(screen.getByRole("radio", { name: /^manual delivery/i }));
    await user.click(screen.getByRole("radio", { name: /^require buyer information/i }));
    await user.click(screen.getByRole("radio", { name: /^automatic delivery/i }));
    await user.click(screen.getByRole("radio", { name: /^manual delivery/i }));

    expect(screen.getByRole("radio", { name: /^no buyer information required/i })).toBeChecked();
    expect(screen.queryByRole("button", { name: /add field/i })).not.toBeInTheDocument();
  });

  it("submits and navigates to the product detail page on success", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiPost).mockResolvedValueOnce({ id: 7, name: "1 Month", slug: "1-month" });

    render(<DenominationCreatePage />, { wrapper: Wrapper });
    await fillBaseFields(user);

    const btn = screen.getByRole("button", { name: /create denomination/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    await user.click(btn);

    expect(apiPost).toHaveBeenCalledWith("/api/catalog/products/42/denominations", {
      name: "1 Month Plan",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "15000",
      deliveryType: "auto",
    });

    await waitFor(() => expect(screen.getByText("product-detail-page")).toBeInTheDocument());
  });

  // Task 14: qtyValue/qtyUnit — omitted from the submit body when blank
  // (same conditional-spread pattern as costPrice/resellerPrice), sent when
  // filled in with qtyValue coerced to a number.
  it("includes qtyValue and qtyUnit in the submit body when filled in", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiPost).mockResolvedValueOnce({ id: 7, name: "86 Diamonds", slug: "86-diamonds" });

    render(<DenominationCreatePage />, { wrapper: Wrapper });
    await fillBaseFields(user);
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. 86/i), { target: { value: "86" } });
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. diamonds/i), { target: { value: "Diamonds" } });

    const btn = screen.getByRole("button", { name: /create denomination/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    await user.click(btn);

    expect(apiPost).toHaveBeenCalledWith("/api/catalog/products/42/denominations", {
      name: "1 Month Plan",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "15000",
      deliveryType: "auto",
      qtyValue: 86,
      qtyUnit: "Diamonds",
    });
  });

  it("omits qtyValue and qtyUnit from the submit body when left blank", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiPost).mockResolvedValueOnce({ id: 7, name: "1 Month", slug: "1-month" });

    render(<DenominationCreatePage />, { wrapper: Wrapper });
    await fillBaseFields(user);

    const btn = screen.getByRole("button", { name: /create denomination/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    await user.click(btn);

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    const [, sentBody] = vi.mocked(apiPost).mock.calls[0] as [string, Record<string, unknown>];
    expect(sentBody).not.toHaveProperty("qtyValue");
    expect(sentBody).not.toHaveProperty("qtyUnit");
  });

  it("submits a manual_with_info SKU with additionalFields as a raw array (not a JSON string)", async () => {
    // Regression test: DenominationCreatePage previously JSON.stringify()d
    // additionalFields before handing it to apiPost, which itself
    // JSON.stringify()s the whole outer body for the actual fetch call —
    // double-encoding the field into a string. The server route expects a
    // raw array (zAdditionalFields = z.array(...)) and rejects a string, so
    // every real submission of a manual_with_info denomination failed with a
    // 400 even though this half's mocked apiPost never caught it. Asserting
    // Array.isArray here (rather than matching a JSON.stringify()d string)
    // pins the real body shape the client must send.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiPost).mockResolvedValueOnce({ id: 8, name: "1 Month Plan", slug: "1-month-plan" });

    render(<DenominationCreatePage />, { wrapper: Wrapper });
    await fillBaseFields(user);

    await user.click(screen.getByRole("radio", { name: /^manual delivery/i }));
    await user.click(screen.getByRole("radio", { name: /^require buyer information/i }));
    await user.click(screen.getByRole("button", { name: /add field/i }));
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. id game/i), { target: { value: "IGN" } });
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. game id/i), { target: { value: "IGN" } });

    const btn = screen.getByRole("button", { name: /create denomination/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    await user.click(btn);

    expect(apiPost).toHaveBeenCalledTimes(1);
    const [, sentBody] = vi.mocked(apiPost).mock.calls[0] as [string, Record<string, unknown>];
    expect(Array.isArray(sentBody.additionalFields)).toBe(true);
    expect(apiPost).toHaveBeenCalledWith("/api/catalog/products/42/denominations", {
      name: "1 Month Plan",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "15000",
      deliveryType: "manual_with_info",
      additionalFields: [
        { key: "ign", label: { id: "IGN", en: "IGN" }, type: "text", required: true, options: [], placeholder: "" },
      ],
    });
  });

  it("switching away from 'Require buyer information' after picking Digiflazz drops autoDeliverySource/supplierSku from the submitted payload", async () => {
    // Regression coverage for the client half of the fix in 024fec6:
    // DeliveryTypeSection's selectBuyerInfo handler is supposed to reset
    // Step 4's Digiflazz choice when the admin backs out of "Require buyer
    // information" — not just hide it. Not a live data-integrity bug (the
    // backend independently strips these fields when deliveryType isn't
    // manual_with_info), but nothing exercised the client-side reset before.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiPost).mockResolvedValueOnce({ id: 9, name: "1 Month Plan", slug: "1-month-plan" });

    render(<DenominationCreatePage />, { wrapper: Wrapper });
    await fillBaseFields(user);

    await user.click(screen.getByRole("radio", { name: /^manual delivery/i }));
    await user.click(screen.getByRole("radio", { name: /^require buyer information/i }));
    await user.click(screen.getByRole("button", { name: /add field/i }));
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. id game/i), { target: { value: "IGN" } });
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. game id/i), { target: { value: "IGN" } });
    await user.click(screen.getByRole("radio", { name: /^digiflazz/i }));
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. mlbb86/i), { target: { value: "mlbb86" } });

    // Back out of "Require buyer information" without changing the method —
    // Step 4 should disappear along with its Digiflazz/Supplier SKU state.
    await user.click(screen.getByRole("radio", { name: /^no buyer information required/i }));
    expect(screen.queryByRole("radio", { name: /^digiflazz/i })).not.toBeInTheDocument();

    const btn = screen.getByRole("button", { name: /create denomination/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    await user.click(btn);

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    const [, sentBody] = vi.mocked(apiPost).mock.calls[0] as [string, Record<string, unknown>];
    expect(sentBody).not.toHaveProperty("autoDeliverySource");
    expect(sentBody).not.toHaveProperty("supplierSku");
    expect(sentBody).not.toHaveProperty("additionalFields");
    expect(sentBody.deliveryType).toBe("manual");
  });


  it("shows an error message when create fails", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiPost).mockRejectedValueOnce(new Error("A valid type is required."));

    render(<DenominationCreatePage />, { wrapper: Wrapper });
    await fillBaseFields(user);

    const btn = screen.getByRole("button", { name: /create denomination/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    await user.click(btn);

    await waitFor(() => expect(screen.getByText(/a valid type is required/i)).toBeInTheDocument());
  });
});

describe("DenominationCreatePage Telegram button hints", () => {
  const gameProduct = { product: { id: 42, name: "Mobile Legends", category: { group: "GAME_TOPUP" } } };

  it("Game Top Up: hints Name and Quantity Unit with their own budgets, not Duration Label", async () => {
    vi.mocked(apiGet).mockResolvedValue(gameProduct);
    render(<DenominationCreatePage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getAllByTestId("button-label-counter")).toHaveLength(2));
    expect(screen.getAllByTestId("button-label-counter").map((el) => el.textContent)).toEqual(["0/24", "0/16"]);
    expect(screen.getAllByText(/Shown on the Telegram Game Top Up button/)).toHaveLength(2);
  });

  it("Premium Apps (and while the product is loading): hints Duration Label, the text on the plan button", async () => {
    vi.mocked(apiGet).mockResolvedValue({ product: { id: 42, name: "Netflix Premium", category: { group: "PREMIUM_APPS" } } });
    render(<DenominationCreatePage />, { wrapper: Wrapper });
    await waitFor(() => screen.getByRole("link", { name: "Netflix Premium" }));
    expect(screen.getAllByTestId("button-label-counter").map((el) => el.textContent)).toEqual(["0/18"]);
    fireEvent.change(screen.getByPlaceholderText(/1 month/i), { target: { value: "1 Month" } });
    expect(screen.getByTestId("button-label-counter")).toHaveTextContent("7/18");
  });

  it("Game Top Up: does not count the game name at the start of the Name", async () => {
    vi.mocked(apiGet).mockResolvedValue(gameProduct);
    render(<DenominationCreatePage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getAllByTestId("button-label-counter")).toHaveLength(2));
    fireEvent.change(screen.getByPlaceholderText(/^e\.g\. netflix premium$/i), { target: { value: "Mobile Legends 86 Diamonds" } });
    // 26 cells raw, 11 once "Mobile Legends " is dropped, which is what the bot shows next to the price.
    expect(screen.getAllByTestId("button-label-counter")[0]).toHaveTextContent("11/24");
    expect(screen.getAllByTestId("button-label-counter")[0]).toHaveAttribute("data-state", "ok");
    expect(screen.queryByTestId("button-label-warning")).toBeNull();
    expect(screen.getByText(/game name at the start is not counted/i)).toBeInTheDocument();
  });

  it("Game Top Up: swaps the Name counter for a neutral note once quantity and unit are both filled", async () => {
    vi.mocked(apiGet).mockResolvedValue(gameProduct);
    render(<DenominationCreatePage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getAllByTestId("button-label-counter")).toHaveLength(2));
    fireEvent.change(screen.getByPlaceholderText(/^e\.g\. netflix premium$/i), { target: { value: "Mobile Legends Weekly Diamond Pass Bundle Supplier Name" } });
    expect(screen.getAllByTestId("button-label-counter")[0]).toHaveAttribute("data-state", "over");
    fireEvent.change(screen.getByPlaceholderText(/^e\.g\. 86$/i), { target: { value: "86" } });
    // Only the unit is filled so far: still the name that is on the button.
    expect(screen.getAllByTestId("button-label-counter")).toHaveLength(2);
    fireEvent.change(screen.getByPlaceholderText(/^e\.g\. diamonds$/i), { target: { value: "Diamonds" } });
    expect(screen.getAllByTestId("button-label-counter")).toHaveLength(1);
    expect(screen.getByTestId("button-label-counter")).toHaveTextContent("8/16");
    expect(screen.getByTestId("button-label-note")).toHaveTextContent(/built from the quantity and unit/i);
    expect(screen.queryByTestId("button-label-warning")).toBeNull();
  });

  it("saving still works with a name over the budget (warning only)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiGet).mockResolvedValue(gameProduct);
    vi.mocked(apiPost).mockResolvedValueOnce({ id: 7, name: "x", slug: "x" });
    render(<DenominationCreatePage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getAllByTestId("button-label-counter")).toHaveLength(2));
    await fillBaseFields(user);
    const longName = "Mobile Legends Weekly Diamond Pass Bundle Supplier Name";
    fireEvent.change(screen.getByPlaceholderText(/^e\.g\. netflix premium$/i), { target: { value: longName } });
    expect(screen.getAllByTestId("button-label-counter")[0]).toHaveAttribute("data-state", "over");
    const btn = screen.getByRole("button", { name: /create denomination/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    await user.click(btn);
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/catalog/products/42/denominations", expect.objectContaining({ name: longName })));
  });
});
