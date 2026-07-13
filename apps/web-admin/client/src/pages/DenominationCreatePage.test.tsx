import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DenominationCreatePage } from "./DenominationCreatePage";
import { apiPost } from "../api/client";

vi.mock("../api/client", () => ({
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
  await user.click(screen.getByRole("combobox", { name: "Type" }));
  await waitFor(() => screen.getByRole("option", { name: "Shared" }));
  await user.click(screen.getByRole("option", { name: "Shared" }));
  fireEvent.change(screen.getByPlaceholderText(/1 month/i), { target: { value: "1 Month" } });
  fireEvent.change(screen.getByPlaceholderText(/15000/i), { target: { value: "15000" } });
}

describe("DenominationCreatePage", () => {
  it("renders name, price, and duration inputs and a submit button", () => {
    render(<DenominationCreatePage />, { wrapper: Wrapper });
    expect(screen.getByPlaceholderText(/1 month/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/15000/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create denomination/i })).toBeInTheDocument();
  });

  it("renders a Delivery Type selector defaulting to Auto", () => {
    render(<DenominationCreatePage />, { wrapper: Wrapper });
    expect(screen.getByRole("combobox", { name: "Delivery Type" })).toBeInTheDocument();
  });

  it("submit button is disabled until name, type, duration, and a valid price are set", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<DenominationCreatePage />, { wrapper: Wrapper });

    const btn = screen.getByRole("button", { name: /create denomination/i });
    expect(btn).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/^e\.g\. netflix premium$/i), { target: { value: "1 Month Plan" } });
    expect(btn).toBeDisabled();

    await user.click(screen.getByRole("combobox", { name: "Type" }));
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

  it("selecting Manual + Info reveals the custom field editor and requires a fully-valid field before submitting", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<DenominationCreatePage />, { wrapper: Wrapper });
    await fillBaseFields(user);

    const btn = screen.getByRole("button", { name: /create denomination/i });
    await waitFor(() => expect(btn).not.toBeDisabled());

    expect(screen.queryByRole("button", { name: /add field/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Delivery Type" }));
    await waitFor(() => screen.getByRole("option", { name: /manual \+ info/i }));
    await user.click(screen.getByRole("option", { name: /manual \+ info/i }));

    expect(screen.getByRole("button", { name: /add field/i })).toBeInTheDocument();
    expect(btn).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /add field/i }));
    expect(btn).toBeDisabled();

    // Key alone isn't enough — fieldsAreValid mirrors the server's real
    // requirements (key format, both bilingual labels, select needs options),
    // so a half-filled row must keep the button disabled rather than let the
    // admin hit the server's generic rejection message.
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. game_id/i), { target: { value: "ign" } });
    expect(btn).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/e\.g\. id game/i), { target: { value: "IGN" } });
    expect(btn).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/e\.g\. game id/i), { target: { value: "IGN" } });
    expect(btn).not.toBeDisabled();
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

    await user.click(screen.getByRole("combobox", { name: "Delivery Type" }));
    await waitFor(() => screen.getByRole("option", { name: /manual \+ info/i }));
    await user.click(screen.getByRole("option", { name: /manual \+ info/i }));
    await user.click(screen.getByRole("button", { name: /add field/i }));
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. game_id/i), { target: { value: "ign" } });
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
