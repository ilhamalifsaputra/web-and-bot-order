import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { TopBar } from "./TopBar";

function LocationDisplay() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}</span>;
}

function renderTopBar() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      if (path === "/logout") return { ok: true, status: 200, json: async () => ({}) };
      return { ok: true, json: async () => ({}) };
    }),
  );
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <TopBar onMenuClick={() => {}} onSearchOpen={() => {}} />
              <LocationDisplay />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("TopBar", () => {
  it("logs out via POST /logout and navigates to /login when Logout is clicked in the avatar dropdown (F-002)", async () => {
    const user = userEvent.setup();
    renderTopBar();
    await user.click(screen.getByRole("button", { name: /admin/i }));
    const logoutButton = await screen.findByRole("button", { name: "Logout" });
    await user.click(logoutButton);
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/logout", expect.objectContaining({ method: "POST" })),
    );
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/login"));
  });
});
