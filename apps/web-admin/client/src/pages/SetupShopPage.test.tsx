import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SetupShopPage } from "./SetupShopPage";

function mockFetch(body: unknown, status = 200) {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("SetupShopPage", () => {
  it("renders shop info form", () => {
    render(
      <MemoryRouter>
        <SetupShopPage />
      </MemoryRouter>,
    );
    expect(screen.getByText("Shop details")).toBeInTheDocument();
    expect(screen.getByLabelText(/shop name/i)).toBeInTheDocument();
  });

  it("navigates on skip button", async () => {
    const loc = { href: "" };
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: loc,
    });
    mockFetch({ ok: true, redirect: "/setup/done" }, 200);
    render(
      <MemoryRouter>
        <SetupShopPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /^skip$/i }));
    await waitFor(() => expect(loc.href).toBe("/setup/done"));
  });

  it("navigates on save", async () => {
    const loc = { href: "" };
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: loc,
    });
    mockFetch({ ok: true, redirect: "/setup/done" }, 200);
    render(
      <MemoryRouter>
        <SetupShopPage />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText(/shop name/i), {
      target: { value: "My Test Shop" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save.*finish/i }));
    await waitFor(() => expect(loc.href).toBe("/setup/done"));
  });
});
