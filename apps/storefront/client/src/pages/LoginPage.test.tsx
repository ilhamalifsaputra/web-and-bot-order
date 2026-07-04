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
  auth_url: string;
}

function renderLogin(initialEntry = "/login", widget: WidgetData = { bot_username: "", auth_url: "" }) {
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

  it("renders the telegram widget script only when bot_username is non-empty", async () => {
    renderLogin("/login", { bot_username: "tokobot", auth_url: "/auth/telegram?next=%2F" });
    await waitFor(() =>
      expect(document.querySelector('script[data-telegram-login="tokobot"]')).toBeInTheDocument(),
    );
    const script = document.querySelector('script[data-telegram-login="tokobot"]') as HTMLScriptElement;
    expect(script.getAttribute("data-auth-url")).toBe("/auth/telegram?next=%2F");
    expect(script.getAttribute("data-request-access")).toBe("write");
  });

  it("omits the telegram widget script when bot_username is empty", async () => {
    renderLogin("/login", { bot_username: "", auth_url: "" });
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(document.querySelector("script[data-telegram-login]")).not.toBeInTheDocument();
  });
});
