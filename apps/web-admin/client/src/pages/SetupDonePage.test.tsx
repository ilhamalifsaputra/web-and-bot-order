import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
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

  it("shows dashboard link", () => {
    render(
      <MemoryRouter>
        <SetupDonePage />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: /go to dashboard/i })).toBeInTheDocument();
  });
});
