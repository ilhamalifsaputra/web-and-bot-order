import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Sidebar } from "./Sidebar";

function LocationDisplay() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}</span>;
}

function renderSidebar() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      if (path === "/logout") {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (path === "/api/settings") {
        return { ok: true, json: async () => ({ fields: [] }) };
      }
      if (path === "/api/dashboard/operations") {
        return {
          ok: true,
          json: async () => ({
            pendingPayments: 2,
            manualReviews: 1,
            failedDeliveries: 0,
            ordersProcessing: 0,
            expiredPayments: 0,
            awaitingFulfillment: 4,
          }),
        };
      }
      if (path === "/api/dashboard/inventory") {
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <Sidebar open={true} onClose={() => {}} />
                <LocationDisplay />
              </>
            }
          />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("Sidebar", () => {
  // Sidebar renders two copies of its nav (always-visible desktop `<aside>`
  // + a mobile drawer `<aside>`), so every nav item/control legitimately
  // appears twice in the DOM — use getAllBy* and assert on the first.
  it("has a single Orders nav item — no separate Awaiting Fulfillment entry (F-001)", async () => {
    renderSidebar();
    await waitFor(() => expect(screen.getAllByText("Orders").length).toBeGreaterThan(0));
    expect(screen.queryByText("Awaiting Fulfillment")).not.toBeInTheDocument();
    expect(screen.getAllByText("Orders")[0]!.closest("a")).toHaveAttribute("href", "/orders");
  });

  it("logs out via POST /logout and navigates to /login on click (F-002)", async () => {
    const user = userEvent.setup();
    renderSidebar();
    const [logoutButton] = screen.getAllByRole("button", { name: "Logout" });
    await user.click(logoutButton!);
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/logout", expect.objectContaining({ method: "POST" })),
    );
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/login"));
  });
});
