import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SetupBotPage } from "./SetupBotPage";

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

describe("SetupBotPage", () => {
  it("renders bot token field and skip option", () => {
    render(
      <MemoryRouter>
        <SetupBotPage />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText(/bot token/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /skip for now/i })).toBeInTheDocument();
  });

  it("shows error on invalid token", async () => {
    mockFetch({ error: "Invalid bot token." }, 400);
    render(
      <MemoryRouter>
        <SetupBotPage />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText(/bot token/i), {
      target: { value: "invalid_token" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save and continue/i }));
    await waitFor(() =>
      expect(screen.getByText("Invalid bot token.")).toBeInTheDocument(),
    );
  });

  it("navigates on skip", async () => {
    const loc = { href: "" };
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: loc,
    });
    mockFetch({ ok: true, redirect: "/setup/owner" }, 200);
    render(
      <MemoryRouter>
        <SetupBotPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    await waitFor(() => expect(loc.href).toBe("/setup/owner"));
  });
});
