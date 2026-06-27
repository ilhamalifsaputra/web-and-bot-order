import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ForgotPage } from "./ForgotPage";

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

describe("ForgotPage", () => {
  it("renders telegram ID field", () => {
    render(
      <MemoryRouter>
        <ForgotPage />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText(/telegram id/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send reset code/i })).toBeInTheDocument();
  });

  it("shows error on API failure", async () => {
    mockFetch({ error: "Telegram ID not found." }, 400);
    render(
      <MemoryRouter>
        <ForgotPage />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText(/telegram id/i), {
      target: { value: "999999999" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send reset code/i }));
    await waitFor(() =>
      expect(screen.getByText("Telegram ID not found.")).toBeInTheDocument(),
    );
  });

  it("shows confirmation after submit", async () => {
    mockFetch({ ok: true, sent: true, telegram_id: "12345" }, 200);
    render(
      <MemoryRouter>
        <ForgotPage />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText(/telegram id/i), {
      target: { value: "12345" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send reset code/i }));
    await waitFor(() =>
      expect(screen.getByText(/check telegram/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/enter reset code/i)).toBeInTheDocument();
  });
});
