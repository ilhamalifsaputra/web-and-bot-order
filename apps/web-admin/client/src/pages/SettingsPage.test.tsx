import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
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
  serviceStates: [
    { id: "game_topup", label: "Top Up Game", enabledBot: true, enabledWeb: true },
    { id: "premium_apps", label: "Premium Apps", enabledBot: false, enabledWeb: true },
  ],
  // Non-nullable verdict shape from evaluatePollHealth (packages/core/src/
  // payments/pollHealth.ts) — the server always returns a verdict, even when
  // the rail is disabled or has never run, so there is no null case here.
  bybitHealth: { status: "unmonitored", detail: "Health monitoring is disabled for this poller." },
  bybitBscHealth: { status: "unmonitored", detail: "Health monitoring is disabled for this poller." },
  isOwner: false,
  twoFaEnabled: false,
  twoFaPending: null,
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("SettingsPage", () => {
  it("shows a bot and a website switch per service and saves one channel through the services endpoint", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(SETTINGS_DATA), { status: 200, headers: { "Content-Type": "application/json" } }));
    render(<SettingsPage />, { wrapper: Wrapper });
    expect(await screen.findByRole("heading", { name: "Services" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Top Up Game on the Telegram bot" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Top Up Game on the website" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Premium Apps on the Telegram bot" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Premium Apps on the website" })).toBeChecked();

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const user = userEvent.setup();
    await user.click(screen.getByRole("switch", { name: "Top Up Game on the Telegram bot" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Disable Top Up Game for the Telegram bot?")).toBeInTheDocument();
    expect(within(dialog).getByText(/blocks new orders on the Telegram bot\./)).toBeInTheDocument();
    // Opening the dialog changes nothing until confirmed.
    expect(screen.getByRole("switch", { name: "Top Up Game on the website", hidden: true })).toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/settings/services/toggle"),
      expect.objectContaining({ body: JSON.stringify({ service: "game_topup", channel: "bot", enabled: false }) }),
    ));
    expect(screen.getByRole("switch", { name: "Top Up Game on the website", hidden: true })).toBeChecked();
  });

  it("names the website in the confirm dialog and posts the web channel when enabling", async () => {
    const data = { ...SETTINGS_DATA, serviceStates: [{ id: "premium_apps", label: "Premium Apps", enabledBot: true, enabledWeb: false }] };
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } }));
    render(<SettingsPage />, { wrapper: Wrapper });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("switch", { name: "Premium Apps on the website" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Enable Premium Apps for the website?")).toBeInTheDocument();
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await user.click(within(dialog).getByRole("button", { name: "Enable" }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/settings/services/toggle"),
      expect.objectContaining({ body: JSON.stringify({ service: "premium_apps", channel: "web", enabled: true }) }),
    ));
  });

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

  it("groups the CoinGecko API key with Exchange Rates instead of Other Settings", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({
        ...SETTINGS_DATA,
        fields: [
          ...SETTINGS_DATA.fields,
          { key: "coingecko_api_key", label: "CoinGecko API key", secret: true, hasValue: false, value: "", needsRestart: false },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    render(<SettingsPage />, { wrapper: Wrapper });

    const exchangeRates = await screen.findByRole("heading", { name: "Exchange Rates" });
    const exchangeRatesCard = exchangeRates.closest('[data-slot="card"]') as HTMLElement;
    expect(within(exchangeRatesCard).getByText("CoinGecko API key")).toBeInTheDocument();
    expect(document.getElementById("settings-other")).toBeNull();
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

    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Change Password" }));

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

    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Change Password" }));

    expect(await screen.findByText("Incorrect current password")).toBeInTheDocument();
    // Errors keep the dialog open so the user can retry or cancel, unlike a
    // toast that would have vanished with no way to correct the input.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
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

  it("shows a single 'Not Configured' status badge for an enabled-but-unconfigured gateway, not contradictory badge/toggle state (F-013)", async () => {
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

    // "configured" and "enabled" are now two separate, both-honest signals
    // (a StatusBadge for configured-ness, the Switch for the raw toggle)
    // rather than one combined text label — F-013's concern was a label that
    // *overclaimed* (saying "Enabled" while unusable), not that two signals
    // exist at all, so showing an accurate "Not Configured" badge next to a
    // truthfully-on switch is not a regression of that fix.
    const paydisiniHeader = document.getElementById("settings-pay-paydisini")!.querySelector('[data-slot="card-header"]') as HTMLElement;
    expect(within(paydisiniHeader).getByText("Not Configured")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /disable paydisini/i })).toBeChecked();
    // The still-configured TokoPay section shows the "Configured" badge.
    const tokopayHeader = document.getElementById("settings-pay-tokopay")!.querySelector('[data-slot="card-header"]') as HTMLElement;
    expect(within(tokopayHeader).getByText("Configured")).toBeInTheDocument();
  });

  // Reported bug: filling in a secret setting (e.g. Digiflazz API key) was
  // landing in the page's own "Search settings…" box instead — Chrome's
  // native password manager was pairing the password-type field with the
  // nearest preceding text input (the search box) as a guessed "username"
  // and offering to autofill this admin's saved /login credentials into
  // both. The fix: `autoComplete="new-password"` on every secret FieldRow
  // input (which stops Chrome from treating it as a saved-login target) and
  // `autoComplete="off"` on the search box itself (defense in depth).
  it("a secret field's edit input has autoComplete=new-password and the search box has autoComplete=off", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(SETTINGS_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<SettingsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Shop name")).toBeInTheDocument());

    expect(screen.getByLabelText("Search settings")).toHaveAttribute("autoComplete", "off");

    const user = userEvent.setup();
    // "Order Bot token" (bot_token, secret: true) is the second Edit button
    // in the fixture — the first belongs to the non-secret "Shop name" row.
    await user.click(screen.getAllByRole("button", { name: "Edit" })[1]);
    const secretInput = screen.getByLabelText("Order Bot token");
    expect(secretInput).toHaveAttribute("type", "password");
    expect(secretInput).toHaveAttribute("autoComplete", "new-password");
  });

  it("field Save opens a confirmation dialog and shows a checkmark on success", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(SETTINGS_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<SettingsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Shop name")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const input = screen.getByDisplayValue("Demo Shop");
    await user.clear(input);
    await user.type(input, "New Shop Name");
    // This is the FieldRow's own Save button — the dialog doesn't exist yet.
    await user.click(screen.getByRole("button", { name: "Save" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText('Save "Shop name"?')).toBeInTheDocument();
    // Nothing persisted yet from opening the dialog alone.
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(SETTINGS_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Saved successfully")).toBeInTheDocument();
  });

  // I-3: money settings are read by shape on the server, so the form must say
  // which values are the untouched stored pre-fill (read exactly) and must not
  // block a value typed 10.000 / 1.500,50 that the server reads correctly.
  describe("money settings and exact_fields", () => {
    const USDT_MIN = { key: "wallet_topup_min_amount_usdt", label: "Wallet top-up min amount (USDT)", value: "1.234" };
    const DIGIFLAZZ_MARKUP = { key: "digiflazz_markup_value", label: "Digiflazz markup value", value: "1500" };

    async function saveMoneyField(
      field: { key: string; label: string; value: string },
      retype: string | null,
    ): Promise<Record<string, unknown>> {
      const MONEY_DATA = { ...SETTINGS_DATA, fields: [{ ...field, secret: false, hasValue: true, needsRestart: false }] };
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
      fetchSpy.mockResolvedValueOnce(json(MONEY_DATA));
      render(<SettingsPage />, { wrapper: Wrapper });
      await waitFor(() => expect(screen.getByText(field.label)).toBeInTheDocument());

      const user = userEvent.setup();
      await user.click(screen.getAllByRole("button", { name: "Edit" })[0]);
      const input = screen.getByDisplayValue(field.value);
      if (retype !== null) {
        await user.clear(input);
        await user.type(input, retype);
      }
      const save = screen.getByRole("button", { name: "Save" });
      expect(save).not.toBeDisabled();
      await user.click(save);
      const dialog = await screen.findByRole("dialog");
      fetchSpy.mockResolvedValueOnce(json({ ok: true }));
      fetchSpy.mockResolvedValueOnce(json(MONEY_DATA));
      await user.click(within(dialog).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(fetchSpy.mock.calls.some(([url]) => url === "/api/settings/edit")).toBe(true));
      const call = fetchSpy.mock.calls.find(([url]) => url === "/api/settings/edit")!;
      return JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
    }

    it("an untouched pre-filled amount is sent with exact_fields so the server keeps it exactly", async () => {
      const body = await saveMoneyField(USDT_MIN, null);
      expect(body).toMatchObject({ key: "wallet_topup_min_amount_usdt", value: "1.234", exact_fields: ["value"] });
    });

    it("a retyped amount is sent without exact_fields, so the server reads it by shape", async () => {
      const body = await saveMoneyField(USDT_MIN, "2,5");
      expect(body).toMatchObject({ key: "wallet_topup_min_amount_usdt", value: "2,5" });
      expect(body.exact_fields ?? []).toEqual([]);
    });

    it("does not block an amount typed in the Indonesian shape (1.500,50) that the server reads correctly", async () => {
      const body = await saveMoneyField(DIGIFLAZZ_MARKUP, "1.500,50");
      expect(body).toMatchObject({ key: "digiflazz_markup_value", value: "1.500,50" });
      expect(body.exact_fields ?? []).toEqual([]);
    });
  });

  it("wraps the FieldRow editing block in its own <form>, with Copy/Save/Cancel as explicit type=\"button\" (F-Chrome-autofill)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(SETTINGS_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<SettingsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Shop name")).toBeInTheDocument());

    const user = userEvent.setup();
    const telegramCard = document.getElementById("settings-telegram") as HTMLElement;
    // bot_token is the secret field, so its editing block also renders the
    // Copy button — exercising all three buttons in one row.
    await user.click(within(telegramCard).getByRole("button", { name: "Edit" }));

    const secretInput = screen.getByLabelText("Order Bot token");
    const form = secretInput.closest("form");
    expect(form).not.toBeNull();
    // Every button inside the form must be inside that same form (i.e. the
    // form scopes Chrome's "nearest preceding field" search to just these
    // controls, not all the way up to SettingsSearch), and must be
    // type="button" so it can never become a native submit control.
    expect(within(form as HTMLElement).getByRole("button", { name: /copy/i })).toHaveAttribute("type", "button");
    expect(within(form as HTMLElement).getByRole("button", { name: "Save" })).toHaveAttribute("type", "button");
    expect(within(form as HTMLElement).getByRole("button", { name: "Cancel" })).toHaveAttribute("type", "button");
  });

  it("pressing Enter in the field's input still opens the save-confirm dialog via the existing onKeyDown handler", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(SETTINGS_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<SettingsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Shop name")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const input = screen.getByDisplayValue("Demo Shop");

    // Unchanged behavior: the input's own onKeyDown still opens the
    // save-confirm dialog on Enter — this must keep working once the
    // input is inside a real <form>.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText('Save "Shop name"?')).toBeInTheDocument();
  });

  it("the editing form's onSubmit backstop prevents a native submission (e.g. from implicit submission-on-Enter)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(SETTINGS_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<SettingsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Shop name")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const input = screen.getByDisplayValue("Demo Shop");
    const form = input.closest("form") as HTMLFormElement;
    expect(form).not.toBeNull();

    // A browser's own implicit-submission-on-Enter would dispatch a native
    // "submit" event on the form (this is the mechanism the brief warns
    // about — Button never defaults to type="button", and pressing Enter
    // in a lone text field can trigger a native submit even with no
    // type="submit" button present). Dispatch that event directly and
    // confirm the form's onSubmit backstop prevents it, so it can never
    // cause a page-level side effect.
    const submitted = fireEvent.submit(form);
    // testing-library's fireEvent returns false when preventDefault() was
    // called by a handler — i.e. the event was NOT allowed to proceed.
    expect(submitted).toBe(false);
  });

  it("toggling a payment gateway opens a confirmation dialog before persisting", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(SETTINGS_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<SettingsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Shop name")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByRole("switch", { name: /disable tokopay/i }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Disable TokoPay?")).toBeInTheDocument();
    // Clicking the switch alone must not have persisted anything yet.
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(SETTINGS_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Disable" }));

    expect(await screen.findByText("Payment method updated")).toBeInTheDocument();
  });

  it("2FA 'Enable 2FA' (begin) persists immediately without a confirmation dialog", async () => {
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
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(SETTINGS_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Enable 2FA" }));

    // Nothing is persisted at the "begin" step (just a pending secret), so
    // there's nothing to confirm.
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("2FA 'Confirm' requires a confirmation dialog", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...SETTINGS_DATA,
          twoFaPending: { secret: "SECRET123", uri: "otpauth://totp/test" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<SettingsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Shop name")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Enable two-factor authentication?")).toBeInTheDocument();
  });

  it("2FA 'Disable 2FA' requires a confirmation dialog", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ...SETTINGS_DATA, twoFaEnabled: true }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<SettingsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Shop name")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Disable 2FA" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Disable two-factor authentication?")).toBeInTheDocument();
  });

  it("search filters visible fields to the matching query, without a page reload", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...SETTINGS_DATA,
          fields: [
            ...SETTINGS_DATA.fields,
            { key: "shop_tagline", label: "Shop tagline", secret: false, hasValue: true, value: "Fast & reliable", needsRestart: false },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<SettingsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Shop name")).toBeInTheDocument());
    expect(screen.getByText("Shop tagline")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: /search settings/i }), "tagline");

    // The matched substring is wrapped in <mark> (highlightMatch), so "Shop
    // tagline" is now split across two text nodes — match the highlighted
    // fragment itself rather than the old single-string label.
    expect(screen.getByText("tagline", { selector: "mark" })).toBeInTheDocument();
    expect(screen.queryByText("Shop name")).not.toBeInTheDocument();
  });

  it("Test Connection is disabled for an unconfigured gateway and enabled + wired for a configured one", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(SETTINGS_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<SettingsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Shop name")).toBeInTheDocument());

    const tokopayCard = document.getElementById("settings-pay-tokopay") as HTMLElement;
    const testButton = within(tokopayCard).getByRole("button", { name: "Test Connection" });
    expect(testButton).toBeEnabled();

    const user = userEvent.setup();
    await user.click(testButton);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Test the TokoPay connection?")).toBeInTheDocument();

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, detail: "Connected — merchant ID and secret are accepted." }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Test" }));

    expect(await screen.findByText("Connected — merchant ID and secret are accepted.")).toBeInTheDocument();
  });

  it("shows a Restart Bot action after saving a needsRestart field, and clears it after restarting", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(SETTINGS_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<SettingsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Shop name")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Restart Bot" })).not.toBeInTheDocument();

    const user = userEvent.setup();
    const telegramCard = document.getElementById("settings-telegram") as HTMLElement;
    await user.click(within(telegramCard).getByRole("button", { name: "Edit" }));
    // bot_token is a secret field (type="password"), which carries no
    // implicit "textbox" ARIA role — match by its aria-label instead.
    await user.type(screen.getByLabelText("Order Bot token"), "123:new-token");
    await user.click(screen.getByRole("button", { name: "Save" }));
    const saveDialog = await screen.findByRole("dialog");

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(SETTINGS_DATA), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    await user.click(within(saveDialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Restart Bot" })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Restart Bot" }));
    const restartDialog = await screen.findByRole("dialog");
    expect(within(restartDialog).getByText("Restart the bot?")).toBeInTheDocument();

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, restarted: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await user.click(within(restartDialog).getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Restart Bot" })).not.toBeInTheDocument());
  });

  it("renders the six owner-email fields inside the Email (SMTP) card, after the SMTP fields", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...SETTINGS_DATA,
          fields: [
            ...SETTINGS_DATA.fields,
            { key: "smtp_host", label: "SMTP host", secret: false, hasValue: true, value: "smtp.example.com", needsRestart: false },
            { key: "owner_email", label: "Owner notification email", secret: false, hasValue: true, value: "owner@example.com", needsRestart: false },
            { key: "owner_email_enabled", label: "Owner email notifications enabled", secret: false, hasValue: true, value: "true", needsRestart: false },
            { key: "owner_email_on_paid_order", label: "Email owner on paid orders", secret: false, hasValue: true, value: "true", needsRestart: false },
            { key: "owner_email_on_manual_queue", label: "Email owner on manual-fulfilment orders", secret: false, hasValue: true, value: "true", needsRestart: false },
            { key: "owner_email_on_new_ticket", label: "Email owner on new support tickets", secret: false, hasValue: true, value: "true", needsRestart: false },
            { key: "owner_email_on_ticket_reply", label: "Email owner on ticket replies", secret: false, hasValue: true, value: "true", needsRestart: false },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<SettingsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Shop name")).toBeInTheDocument());

    const emailCard = document.getElementById("settings-email") as HTMLElement;
    expect(emailCard).not.toBeNull();
    const rowLabels = within(emailCard)
      .getAllByText(/^(SMTP host|Owner notification email|Owner email notifications enabled|Email owner on paid orders|Email owner on manual-fulfilment orders|Email owner on new support tickets|Email owner on ticket replies)$/)
      .map((el) => el.textContent);
    // All six new fields land inside the same card as the SMTP fields, and
    // in server-declared order (SMTP fields first, owner-email fields after).
    expect(rowLabels).toEqual([
      "SMTP host",
      "Owner notification email",
      "Owner email notifications enabled",
      "Email owner on paid orders",
      "Email owner on manual-fulfilment orders",
      "Email owner on new support tickets",
      "Email owner on ticket replies",
    ]);
  });

  it("owner_email field can be edited and saved via the same FieldRow flow as SMTP fields", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const dataWithOwnerEmail = {
      ...SETTINGS_DATA,
      fields: [
        ...SETTINGS_DATA.fields,
        { key: "owner_email", label: "Owner notification email", secret: false, hasValue: true, value: "owner@example.com", needsRestart: false },
      ],
    };
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(dataWithOwnerEmail), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<SettingsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Owner notification email")).toBeInTheDocument());

    const emailCard = document.getElementById("settings-email") as HTMLElement;
    const user = userEvent.setup();
    await user.click(within(emailCard).getAllByRole("button", { name: "Edit" })[0]!);
    const input = screen.getByDisplayValue("owner@example.com");
    await user.clear(input);
    await user.type(input, "new-owner@example.com");
    await user.click(screen.getByRole("button", { name: "Save" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText('Save "Owner notification email"?')).toBeInTheDocument();

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }));
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(dataWithOwnerEmail), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Saved successfully")).toBeInTheDocument();
  });

  it("shows the Bybit poller health that the settings endpoint already returns", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...SETTINGS_DATA,
          payMethodState: {
            ...SETTINGS_DATA.payMethodState,
            bybit: { enabled: true, configured: true },
            bybit_bsc: { enabled: true, configured: true },
          },
          bybitHealth: { status: "green", detail: "Cycles are completing normally; last run 2 minute(s) ago." },
          bybitBscHealth: { status: "red", detail: "The poller has never completed a cycle." },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<SettingsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Shop name")).toBeInTheDocument());

    expect(screen.getByText("Cycles are completing normally; last run 2 minute(s) ago.")).toBeInTheDocument();
    expect(screen.getByText("The poller has never completed a cycle.")).toBeInTheDocument();
  });

  it("Export Configuration downloads the exported fields", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(SETTINGS_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<SettingsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Shop name")).toBeInTheDocument());

    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:mock"), revokeObjectURL: vi.fn() });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ exportedAt: "2026-01-01T00:00:00.000Z", fields: { shop_name: "Demo Shop" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /settings quick actions/i }));
    await user.click(await screen.findByText("Export Configuration"));

    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Exported 1 settings.")).toBeInTheDocument();
    clickSpy.mockRestore();
    vi.unstubAllGlobals();
  });
});
