import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { SettingsPage } from "./SettingsPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        {children}
        <Toaster />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const SETTINGS_DATA = {
  fields: [
    { key: "shop_name", label: "Shop name", secret: false, hasValue: true, value: "Demo Shop", needsRestart: false },
    { key: "bot_token", label: "Order Bot token", secret: true, hasValue: true, value: "", needsRestart: true },
  ],
  payMethodState: {
    tokopay: { enabled: true, configured: true },
  },
  bybitHealth: null,
  bybitBscHealth: null,
  isOwner: false,
  twoFaEnabled: false,
  twoFaPending: null,
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("SettingsPage", () => {
  it("shows a settings field label in the rendered page", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(SETTINGS_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<SettingsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Shop name")).toBeInTheDocument());
    expect(screen.getByText("Order Bot token")).toBeInTheDocument();
  });

  it("shows loading state while fetching", () => {
    vi.spyOn(globalThis, "fetch").mockReturnValueOnce(new Promise(() => {}));
    render(<SettingsPage />, { wrapper: Wrapper });
    expect(screen.getByText(/loading settings/i)).toBeInTheDocument();
  });

  it("shows failed to load on fetch error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<SettingsPage />, { wrapper: Wrapper });
    await waitFor(() =>
      expect(screen.getByText(/failed to load settings/i)).toBeInTheDocument(),
    );
  });

  it("shows a success banner after changing the password", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(SETTINGS_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<SettingsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Shop name")).toBeInTheDocument());

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("Current password"), "old-password");
    await user.type(screen.getByPlaceholderText("New password (min 8 chars)"), "new-password");
    await user.click(screen.getByRole("button", { name: "Change Password" }));

    expect(await screen.findByText("Password changed successfully.")).toBeInTheDocument();
  });

  it("shows an error banner when changing the password fails", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(SETTINGS_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<SettingsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Shop name")).toBeInTheDocument());

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Incorrect current password" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("Current password"), "wrong-password");
    await user.type(screen.getByPlaceholderText("New password (min 8 chars)"), "new-password");
    await user.click(screen.getByRole("button", { name: "Change Password" }));

    expect(await screen.findByText("Incorrect current password")).toBeInTheDocument();
  });

  it("renders a section nav with links to General and Security that jump to the matching section id (F-012)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(SETTINGS_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<SettingsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Shop name")).toBeInTheDocument());

    const nav = screen.getByRole("navigation", { name: /settings sections/i });
    const generalLink = within(nav).getByRole("link", { name: "General" });
    expect(generalLink).toHaveAttribute("href", "#settings-general");
    const securityLink = within(nav).getByRole("link", { name: "Security" });
    expect(securityLink).toHaveAttribute("href", "#settings-security");

    // The Security section itself is reachable via that anchor id, and every
    // field/behavior below it is unchanged (whitelist-only editing, per-field
    // Edit button) — this is a layout wrapper, not a content change.
    expect(document.getElementById("settings-security")).not.toBeNull();
    expect(document.getElementById("settings-general")).not.toBeNull();
  });

  it("never renders a 'Store' card — min_order_amount/order_expiry_minutes/stock_low_threshold are not real settings (dead STORE_KEYS code removed)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...SETTINGS_DATA,
          fields: [
            ...SETTINGS_DATA.fields,
            { key: "min_order_amount", label: "Min order amount", secret: false, hasValue: true, value: "10000", needsRestart: false },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<SettingsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Shop name")).toBeInTheDocument());

    expect(screen.queryByText("Store")).not.toBeInTheDocument();
    // The stray field still renders somewhere (Other Settings), not silently dropped.
    expect(screen.getByText("Min order amount")).toBeInTheDocument();
  });

  it("shows a single 'Not set up' status for an enabled-but-unconfigured gateway, not contradictory 'Enabled' + 'not configured' text (F-013)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...SETTINGS_DATA,
          fields: [
            ...SETTINGS_DATA.fields,
            { key: "paydisini_userkey", label: "PayDisini Userkey", secret: true, hasValue: false, value: "", needsRestart: false },
          ],
          payMethodState: {
            tokopay: { enabled: true, configured: true },
            // Enabled by default but no credentials set yet — this is the
            // exact contradictory-looking combination F-013 reported.
            paydisini: { enabled: true, configured: false },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<SettingsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Shop name")).toBeInTheDocument());

    expect(screen.getByText("Not set up")).toBeInTheDocument();
    expect(screen.queryByText("not configured")).not.toBeInTheDocument();
    // The Enabled/Disabled text next to the switch is gone (replaced by the
    // one combined badge above), but the switch itself is untouched — same
    // `enabled` value, same toggle mutation, just no separate text label.
    expect(screen.getByRole("switch", { name: /disable paydisini/i })).toBeChecked();
    // The still-configured TokoPay section shows the normal "Enabled" badge.
    expect(screen.getByText("Enabled")).toBeInTheDocument();
  });
});
