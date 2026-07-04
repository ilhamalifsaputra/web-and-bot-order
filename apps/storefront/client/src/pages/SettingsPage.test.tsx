import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SettingsPage from "./SettingsPage";
import { apiGet, apiPost } from "../api/client";
import type { SettingsData } from "../api/types";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

const settingsData: SettingsData = {
  bot_username: "tokobot",
  values: { username: "alice", email: "alice@example.com" },
  has_password: true,
  tg_linked: false,
  tg_name: "",
};

function renderSettings(initialEntry = "/account/settings", data: SettingsData = settingsData) {
  (apiGet as Mock).mockResolvedValue(data);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/account/settings" element={<SettingsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SettingsPage", () => {
  let originalLocation: PropertyDescriptor | undefined;

  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
    originalLocation = Object.getOwnPropertyDescriptor(window, "location");
  });

  afterEach(() => {
    if (originalLocation) Object.defineProperty(window, "location", originalLocation);
  });

  it("shows the saved flash for ?saved=1", async () => {
    renderSettings("/account/settings?saved=1");
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
  });

  it("shows the linked flash for ?linked=1", async () => {
    renderSettings("/account/settings?linked=1");
    expect(await screen.findByText("Telegram linked!")).toBeInTheDocument();
  });

  it("shows the tg_taken error for ?err=tg_taken", async () => {
    renderSettings("/account/settings?err=tg_taken");
    expect(
      await screen.findByText("That Telegram account is already linked to another member."),
    ).toBeInTheDocument();
  });

  it("shows the generic error for ?err=tg_invalid", async () => {
    renderSettings("/account/settings?err=tg_invalid");
    expect(await screen.findByText("Something went wrong. Please try again.")).toBeInTheDocument();
  });

  it("renders the translated error key from a 400 credentials response", async () => {
    renderSettings();
    await screen.findByLabelText("Username");
    (apiPost as Mock).mockRejectedValue(new Error("web.settings_wrong_password"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Current password is wrong.")).toBeInTheDocument();
  });

  it("assigns /account/settings?saved=1 on a successful credentials save", async () => {
    const assign = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, writable: true, value: { assign } });
    renderSettings();
    await screen.findByLabelText("Username");
    (apiPost as Mock).mockResolvedValue({ ok: true, password_changed: false });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/v1/account/settings/credentials", {
        username: "alice",
        email: "alice@example.com",
        current_password: "",
        new_password: "",
      }),
    );
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/account/settings?saved=1"));
  });

  it("renders the Telegram widget script only when !tg_linked && bot_username", async () => {
    renderSettings("/account/settings", { ...settingsData, tg_linked: false, bot_username: "tokobot" });
    await waitFor(() =>
      expect(document.querySelector('script[data-telegram-login="tokobot"]')).toBeInTheDocument(),
    );
    const script = document.querySelector('script[data-telegram-login="tokobot"]') as HTMLScriptElement;
    expect(script.getAttribute("data-auth-url")).toBe("/account/settings/link-telegram");
  });

  it("omits the widget when already tg_linked", async () => {
    renderSettings("/account/settings", { ...settingsData, tg_linked: true, tg_name: "Alice T" });
    expect(await screen.findByText("Linked to Telegram as Alice T.")).toBeInTheDocument();
    expect(document.querySelector("script[data-telegram-login]")).not.toBeInTheDocument();
  });

  it("omits the widget when no bot_username is configured", async () => {
    renderSettings("/account/settings", { ...settingsData, tg_linked: false, bot_username: "" });
    expect(await screen.findByText("Telegram sign-in isn't set up yet.")).toBeInTheDocument();
    expect(document.querySelector("script[data-telegram-login]")).not.toBeInTheDocument();
  });
});
