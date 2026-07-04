import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ForgotPage from "./ForgotPage";
import { publicPost } from "../api/client";

vi.mock("../api/client", () => ({
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
});
