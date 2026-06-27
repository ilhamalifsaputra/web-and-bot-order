import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SetupOwnerPage } from "./SetupOwnerPage";

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

function fillOwnerForm() {
  fireEvent.change(screen.getByLabelText(/telegram id/i), {
    target: { value: "123456789" },
  });
  fireEvent.change(screen.getByLabelText(/^password/i), {
    target: { value: "strongpassword" },
  });
  fireEvent.change(screen.getByLabelText(/confirm password/i), {
    target: { value: "strongpassword" },
  });
}

describe("SetupOwnerPage", () => {
  it("renders owner setup form", () => {
    render(
      <MemoryRouter>
        <SetupOwnerPage />
      </MemoryRouter>,
    );
    expect(screen.getByText("Create owner account")).toBeInTheDocument();
    expect(screen.getByLabelText(/telegram id/i)).toBeInTheDocument();
  });

  it("shows error message from API", async () => {
    mockFetch({ error: "Telegram ID already in use." }, 400);
    render(
      <MemoryRouter>
        <SetupOwnerPage />
      </MemoryRouter>,
    );
    fillOwnerForm();
    fireEvent.click(screen.getByRole("button", { name: /create account and continue/i }));
    await waitFor(() =>
      expect(screen.getByText("Telegram ID already in use.")).toBeInTheDocument(),
    );
  });

  it("navigates on success", async () => {
    const loc = { href: "" };
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: loc,
    });
    mockFetch({ ok: true, redirect: "/setup/shop" }, 200);
    render(
      <MemoryRouter>
        <SetupOwnerPage />
      </MemoryRouter>,
    );
    fillOwnerForm();
    fireEvent.click(screen.getByRole("button", { name: /create account and continue/i }));
    await waitFor(() => expect(loc.href).toBe("/setup/shop"));
  });
});
