import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SetupDonePage } from "./SetupDonePage";

beforeEach(() => {
  vi.restoreAllMocks();
  document.head.innerHTML = '<meta name="setup-bot-configured" content="false">';
});

describe("SetupDonePage", () => {
  it("renders done page", () => {
    render(
      <MemoryRouter>
        <SetupDonePage />
      </MemoryRouter>,
    );
    expect(screen.getByText("Setup complete!")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /restart server/i })).toBeInTheDocument();
  });

  it("shows bot configuration info when bot not configured", () => {
    render(
      <MemoryRouter>
        <SetupDonePage />
      </MemoryRouter>,
    );
    expect(screen.getByText(/bot not configured/i)).toBeInTheDocument();
  });

  it("sends the page's CSRF token with the restart POST (Task C3)", async () => {
    document.head.insertAdjacentHTML("beforeend", '<meta name="csrf-token" content="owner-csrf">');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, restarted: true, bot_configured: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(
        <MemoryRouter>
          <SetupDonePage />
        </MemoryRouter>,
      );
      fireEvent.click(screen.getByRole("button", { name: /restart server/i }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(path).toBe("/setup/restart");
      expect((init.headers as Record<string, string>)["X-CSRF-Token"]).toBe("owner-csrf");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows dashboard link", () => {
    render(
      <MemoryRouter>
        <SetupDonePage />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: /go to dashboard/i })).toBeInTheDocument();
  });
});
