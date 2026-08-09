import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ForgotPage from "./ForgotPage";
import { publicPost } from "../api/client";

// apiGet backs AuthBrandPanel's useShopContext() (Task 16) — its response
// shape doesn't matter to this page's own behavior, only that it resolves.
vi.mock("../api/client", () => ({
  apiGet: vi.fn().mockResolvedValue({}),
  publicPost: vi.fn(),
}));

function renderForgot() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/forgot"]}>
        <ForgotPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ForgotPage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  it("renders the email form initially (no unavailable-on-load fetch)", () => {
    renderForgot();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send reset link" })).toBeInTheDocument();
  });

  it("swaps to the sent notice on {sent:true}", async () => {
    renderForgot();
    (publicPost as Mock).mockResolvedValue({ sent: true, unavailable: false });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "alice@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(
      await screen.findByText("If that email is registered, a reset link is on its way."),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
  });

  it("swaps to the unavailable notice on {unavailable:true}", async () => {
    renderForgot();
    (publicPost as Mock).mockResolvedValue({ sent: false, unavailable: true });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "alice@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(
      await screen.findByText("Password reset isn't available right now — please contact support."),
    ).toBeInTheDocument();
  });

  it("renders the rate-limited error over sent/unavailable", async () => {
    renderForgot();
    (publicPost as Mock).mockRejectedValue(new Error("error.rate_limited"));
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "alice@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByText("Too many requests. Please wait a moment.")).toBeInTheDocument();
  });

  // Task 16: the page now shares its <main> with AuthBrandPanel — no longer
  // a bare card floating on an empty background, and no longer a dead end
  // with zero route to the policies.
  it("renders the brand panel's trust strip and policy links", () => {
    renderForgot();
    expect(screen.getByText("Instant delivery")).toBeInTheDocument();
    expect(screen.getByText("QRIS & USDT")).toBeInTheDocument();
    expect(screen.getByText("Warranty included")).toBeInTheDocument();
    expect(screen.getByText("24/7 support")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Terms & Conditions" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy");
    expect(screen.getByRole("link", { name: "Refund Policy" })).toHaveAttribute("href", "/refund");
  });
});
