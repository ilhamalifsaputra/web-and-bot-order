import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
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
  bot_id: "123",
  values: { username: "alice", email: "alice@example.com" },
  has_password: true,
  is_guest: false,
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

  // The credentials error belongs to the form, not the page: on a phone a
  // message at the top of the document is off-screen once you have scrolled
  // down to Save.
  it("renders the credentials error inside the form as an alert", async () => {
    renderSettings();
    const form = (await screen.findByLabelText("Username")).closest("form")!;
    (apiPost as Mock).mockRejectedValue(new Error("web.settings_wrong_password"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Current password is wrong.");
    expect(within(form).getByRole("alert")).toHaveTextContent("Current password is wrong.");
  });

  it("gives every credentials field its autofill and mobile-keyboard hints", async () => {
    renderSettings();
    const username = await screen.findByLabelText("Username");
    expect(username).toHaveAttribute("autocomplete", "username");
    expect(username).toHaveAttribute("autocapitalize", "none");
    expect(username).toHaveAttribute("pattern", "[a-z0-9_]+");
    const email = screen.getByLabelText("Email");
    expect(email).toHaveAttribute("type", "email");
    expect(email).toHaveAttribute("inputmode", "email");
    expect(email).toHaveAttribute("autocomplete", "email");
    expect(screen.getByLabelText("Current password")).toHaveAttribute("autocomplete", "current-password");
    expect(screen.getByLabelText(/New password/)).toHaveAttribute("autocomplete", "new-password");
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

  it("a guest row gets the order-email field and sends it as guest_email (Task C1)", async () => {
    const assign = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, writable: true, value: { assign } });
    renderSettings("/account/settings", {
      ...settingsData,
      values: { username: "", email: "" },
      has_password: false,
      is_guest: true,
    });
    const field = await screen.findByLabelText("Order email");
    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
    fireEvent.change(field, { target: { value: "buyer@example.com" } });
    (apiPost as Mock).mockResolvedValue({ ok: true, password_changed: true });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        "/api/v1/account/settings/credentials",
        expect.objectContaining({ guest_email: "buyer@example.com" }),
      ),
    );
  });

  it("a non-guest row shows no order-email field", async () => {
    renderSettings();
    await screen.findByLabelText("Username");
    expect(screen.queryByLabelText("Order email")).not.toBeInTheDocument();
  });

  it("renders the Continue with Telegram button when !tg_linked && bot_id", async () => {
    renderSettings("/account/settings", { ...settingsData, tg_linked: false, bot_id: "123" });
    expect(await screen.findByRole("button", { name: "Continue with Telegram" })).toBeInTheDocument();
  });

  it("omits the button when already tg_linked", async () => {
    renderSettings("/account/settings", { ...settingsData, tg_linked: true, tg_name: "Alice T" });
    expect(await screen.findByText("Linked to Telegram as Alice T.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue with Telegram" })).not.toBeInTheDocument();
  });

  // Backend audit Task C fix round: the link callback only accepts a link the
  // account armed via a CSRF-checked POST first.
  it("arms the link (POST .../link-telegram/start) before leaving for Telegram", async () => {
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { assign, origin: "https://shop.local" },
    });
    (apiPost as Mock).mockResolvedValue({ ok: true });
    renderSettings("/account/settings", { ...settingsData, tg_linked: false, bot_id: "123" });
    fireEvent.click(await screen.findByRole("button", { name: "Continue with Telegram" }));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith("/api/v1/account/settings/link-telegram/start", {});
    expect(String(assign.mock.calls[0]![0])).toContain("https://oauth.telegram.org/auth?");
  });

  it("a guest row gets no Telegram button, just the claim-first hint", async () => {
    renderSettings("/account/settings", { ...settingsData, is_guest: true, has_password: false, bot_id: "123" });
    expect(
      await screen.findByText("Save a username and password for this account first, then you can link Telegram."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue with Telegram" })).not.toBeInTheDocument();
  });

  it("shows the guest and already-linked errors from the link redirect", async () => {
    renderSettings("/account/settings?err=tg_already_linked");
    expect(
      await screen.findByText("This account is already linked to a different Telegram account."),
    ).toBeInTheDocument();
  });

  it("omits the button when no bot_id is configured", async () => {
    renderSettings("/account/settings", { ...settingsData, tg_linked: false, bot_id: "" });
    expect(await screen.findByText("Telegram sign-in isn't set up yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue with Telegram" })).not.toBeInTheDocument();
  });
});
