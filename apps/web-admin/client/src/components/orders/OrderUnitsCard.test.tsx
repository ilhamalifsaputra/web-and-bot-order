import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OrderUnitsCard, type OrderUnit } from "./OrderUnitsCard";
import { apiPost } from "../../api/client";

vi.mock("../../api/client", () => ({ apiPost: vi.fn(), apiGet: vi.fn() }));

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

function unit(id: number): OrderUnit {
  return {
    id,
    quantity: 1,
    unitPrice: "18000",
    product: { id: 9, name: "Gemini AI 18 Month Link" },
    stockItem: { id: 900 + id, credentials: `link-${id}` },
  };
}

beforeEach(() => {
  vi.mocked(apiPost).mockReset();
});

describe("OrderUnitsCard — action wording", () => {
  it("keeps the Report Issue wording on the order page", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(
      <OrderUnitsCard orderId="55" units={[unit(1), unit(2)]} replacements={[]} isDelivered />,
      { wrapper: Wrapper },
    );

    expect(screen.getAllByRole("button", { name: "Report Issue" })).toHaveLength(2);
    await user.click(screen.getByRole("checkbox", { name: "Select every replaceable unit" }));
    expect(screen.getByRole("button", { name: "Report Issue (2 units)" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Report Issue (2 units)" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Report 2 bad accounts?")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Report" })).toBeInTheDocument();
  });

  it("reads as creating a replacement on a support ticket, and still records the ticket", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(apiPost).mockResolvedValue({ status: "COMPLETED", credentialIssued: true, buyerNotified: true });
    render(
      <OrderUnitsCard
        orderId="55"
        units={[unit(1), unit(2)]}
        replacements={[]}
        isDelivered
        showCredentials={false}
        supportTicketId={34}
      />,
      { wrapper: Wrapper },
    );

    expect(screen.queryByRole("button", { name: /report issue/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Create replacement" })).toHaveLength(2);

    await user.click(screen.getByRole("checkbox", { name: "Select every replaceable unit" }));
    await user.click(screen.getByRole("button", { name: "Create replacement (2 units)" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Create replacements for 2 units?")).toBeInTheDocument();

    await user.type(within(dialog).getByPlaceholderText(/what was wrong/i), "links expired");
    await user.click(within(dialog).getByRole("button", { name: "Create replacement" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2));
    expect(apiPost).toHaveBeenCalledWith("/api/orders/55/items/1/replace", {
      reason: "links expired",
      supportTicketId: 34,
    });
    expect(apiPost).toHaveBeenCalledWith("/api/orders/55/items/2/replace", {
      reason: "links expired",
      supportTicketId: 34,
    });
  });

  it("names a single-unit ticket replacement in the singular", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(
      <OrderUnitsCard orderId="55" units={[unit(1)]} replacements={[]} isDelivered supportTicketId={34} />,
      { wrapper: Wrapper },
    );

    await user.click(screen.getByRole("button", { name: "Create replacement" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Create a replacement?")).toBeInTheDocument();
  });
});
