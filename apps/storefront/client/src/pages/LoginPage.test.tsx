import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import LoginPage from "./LoginPage";
import { apiGet, publicPost } from "../api/client";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
  publicPost: vi.fn(),
}));

interface WidgetData {
  bot_username: string;
  bot_id: string;
  auth_url: string;
}

function renderLogin(
  initialEntry = "/login",
  widget: WidgetData = { bot_username: "", bot_id: "", auth_url: "" },
) {
  (apiGet as Mock).mockResolvedValue(widget);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("LoginPage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  it("renders the identifier and password fields", () => {
    renderLogin();
    expect(screen.getByLabelText("Username or email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  // A guest buyer has no password, so this page is a dead end for them — and
  // it is where they land when they go looking for an order. One quiet link
  // out to /track is all that's needed.
  it("offers guest buyers a way to their order without an account", () => {
    renderLogin();
    expect(screen.getByRole("link", { name: "Bought as a guest? Track your order" })).toHaveAttribute(
      "href",
      "/track",
    );
  });

  it("renders the web.login_failed copy via Flash on a 403 response", async () => {
    renderLogin();
    (publicPost as Mock).mockRejectedValue(new Error("web.login_failed"));
    fireEvent.change(screen.getByLabelText("Username or email"), { target: { value: "alice" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Wrong username or password.")).toBeInTheDocument();
  });

  it("calls window.location.assign with the redirect on success", async () => {
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { assign },
    });
    renderLogin();
    (publicPost as Mock).mockResolvedValue({ redirect: "/account" });
    fireEvent.change(screen.getByLabelText("Username or email"), { target: { value: "alice" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(publicPost).toHaveBeenCalledWith("/api/v1/auth/login", {
        identifier: "alice",
        password: "correct-horse",
        next: "/",
      }),
    );
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/account"));
  });

  it("shows the reset-done notice for ?reset=1", async () => {
    renderLogin("/login?reset=1");
    expect(await screen.findByText("Password updated — sign in with your new password.")).toBeInTheDocument();
  });

  it("shows the tg_unlinked notice for ?err=tg_unlinked", async () => {
    renderLogin("/login?err=tg_unlinked");
    expect(
      await screen.findByText(
        "This Telegram account isn't registered yet — create an account below, or /start the bot first.",
      ),
    ).toBeInTheDocument();
  });

  it("renders the Continue with Telegram button when bot_id is present", async () => {
    renderLogin("/login", { bot_username: "tokobot", bot_id: "123", auth_url: "/auth/telegram?next=%2F" });
    expect(await screen.findByRole("button", { name: "Continue with Telegram" })).toBeInTheDocument();
  });

  it("omits the Continue with Telegram button when bot_id is empty", async () => {
    renderLogin("/login", { bot_username: "", bot_id: "", auth_url: "" });
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Continue with Telegram" })).not.toBeInTheDocument();
  });

  // Task 16: the page now shares its <main> with AuthBrandPanel — no
  // longer a bare card floating on an empty background, and no longer a
  // dead end with zero route to the policies.
  it("renders the brand panel's trust strip and policy links", () => {
    renderLogin();
    expect(screen.getByText("Instant delivery")).toBeInTheDocument();
    expect(screen.getByText("QRIS & USDT")).toBeInTheDocument();
    expect(screen.getByText("Warranty per plan")).toBeInTheDocument();
    expect(screen.getByText("Help via support ticket")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Terms & Conditions" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy");
    expect(screen.getByRole("link", { name: "Refund Policy" })).toHaveAttribute("href", "/refund");
  });
});
