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

describe("DenominationCreatePage", () => {
  it("renders name, price, and duration inputs and a submit button", () => {
    render(<DenominationCreatePage />, { wrapper: Wrapper });
    expect(screen.getByPlaceholderText(/1 month/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/15000/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create denomination/i })).toBeInTheDocument();
  });

  it("submit button is disabled until name, type, duration, and a valid price are set", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<DenominationCreatePage />, { wrapper: Wrapper });

    const btn = screen.getByRole("button", { name: /create denomination/i });
    expect(btn).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/^e\.g\. netflix premium$/i), { target: { value: "1 Month Plan" } });
    expect(btn).toBeDisabled();

    await user.click(screen.getByRole("combobox"));
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

  it("submits and navigates to the product detail page on success", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiPost).mockResolvedValueOnce({ id: 7, name: "1 Month", slug: "1-month" });

    render(<DenominationCreatePage />, { wrapper: Wrapper });

    fireEvent.change(screen.getByPlaceholderText(/^e\.g\. netflix premium$/i), { target: { value: "1 Month Plan" } });
    await user.click(screen.getByRole("combobox"));
    await waitFor(() => screen.getByRole("option", { name: "Shared" }));
    await user.click(screen.getByRole("option", { name: "Shared" }));
    fireEvent.change(screen.getByPlaceholderText(/1 month/i), { target: { value: "1 Month" } });
    fireEvent.change(screen.getByPlaceholderText(/15000/i), { target: { value: "15000" } });

    const btn = screen.getByRole("button", { name: /create denomination/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    await user.click(btn);

    expect(apiPost).toHaveBeenCalledWith("/api/catalog/products/42/denominations", {
      name: "1 Month Plan",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "15000",
    });

    await waitFor(() => expect(screen.getByText("product-detail-page")).toBeInTheDocument());
  });

  it("shows an error message when create fails", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiPost).mockRejectedValueOnce(new Error("A valid type is required."));

    render(<DenominationCreatePage />, { wrapper: Wrapper });

    fireEvent.change(screen.getByPlaceholderText(/^e\.g\. netflix premium$/i), { target: { value: "1 Month Plan" } });
    await user.click(screen.getByRole("combobox"));
    await waitFor(() => screen.getByRole("option", { name: "Shared" }));
    await user.click(screen.getByRole("option", { name: "Shared" }));
    fireEvent.change(screen.getByPlaceholderText(/1 month/i), { target: { value: "1 Month" } });
    fireEvent.change(screen.getByPlaceholderText(/15000/i), { target: { value: "15000" } });

    const btn = screen.getByRole("button", { name: /create denomination/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    await user.click(btn);

    await waitFor(() => expect(screen.getByText(/a valid type is required/i)).toBeInTheDocument());
  });
});
