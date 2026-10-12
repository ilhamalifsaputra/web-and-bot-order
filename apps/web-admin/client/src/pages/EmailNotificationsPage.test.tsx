import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { EmailNotificationsPage } from "./EmailNotificationsPage";

afterEach(() => vi.restoreAllMocks());
const data = { configured: false, policy: "Queued messages follow current preferences.", events: [
  { key: "order.received.customer", label: "Order received", description: "An order was created, before payment.", category: "Orders", audience: "customer", enabled: false, mandatory: false },
  { key: "account.password_reset.requested", label: "Password reset", description: "Account recovery", category: "Account & Security", audience: "customer", enabled: true, mandatory: true },
] };
function mount() {
  return render(<MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><EmailNotificationsPage /></QueryClientProvider></MemoryRouter>);
}
it("separates SMTP readiness from preferences and locks mandatory recovery ON", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));
  mount();
  expect(await screen.findByText("SMTP not configured")).toBeInTheDocument();
  expect(screen.getByRole("switch", { name: "Order received" })).not.toBeChecked();
  expect(screen.getByRole("switch", { name: "Password reset" })).toBeChecked();
  expect(screen.getByRole("switch", { name: "Password reset" })).toBeDisabled();
});
it("posts a boolean preference and retains the saved state after failure", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));
  mount();
  const toggle = await screen.findByRole("switch", { name: "Order received" });
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Unable to save preference." }), { status: 400 }));
  await userEvent.setup().click(toggle);
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/settings/email-notifications", expect.objectContaining({ body: JSON.stringify({ key: "order.received.customer", enabled: true }) })));
  expect(await screen.findByRole("alert")).toHaveTextContent("Unable to save preference.");
  expect(toggle).not.toBeChecked();
});
it("saves report schedule separately from the event switches", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ ...data, schedule: { timezone: "Asia/Jakarta", dailyTime: "08:00", weeklyDay: 1, weeklyTime: "09:00" } }), { status: 200 }));
  mount();
  const time = await screen.findByLabelText("Daily report time");
  await userEvent.setup().clear(time);
  // Native time inputs use a normalized HH:mm value.
  const { fireEvent } = await import("@testing-library/react");
  fireEvent.change(time, { target: { value: "10:30" } });
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  fetch.mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));
  await userEvent.setup().click(screen.getByRole("button", { name: "Save report schedule" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/settings/email-notifications/schedule", expect.objectContaining({ body: JSON.stringify({ timezone: "Asia/Jakarta", dailyTime: "10:30", weeklyDay: 1, weeklyTime: "09:00" }) })));
});

it("loads read-only delivery diagnostics on request without exposing email addresses", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));
  mount();
  await screen.findByText("SMTP not configured");
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ inspected: 14, transportAccepted: 6, sentWithoutEvidence: 8, legacySuppressionCandidates: 8, noValidRecipient: 2, notSent: 2, recentOrdersInspected: 8, recentOrdersWithoutEmail: 8, readOnly: true, inboxDeliveryConfirmed: false }), { status: 200 }));
  await userEvent.setup().click(screen.getByRole("button", { name: "Inspect email delivery" }));
  expect(await screen.findByText("SMTP acceptance recorded: 6")).toBeInTheDocument();
  expect(screen.getByText("Sent without acceptance evidence: 8")).toBeInTheDocument();
  expect(fetch).toHaveBeenLastCalledWith("/api/settings/email/diagnostics", expect.anything());
});

it("shows a render-only preview without toggling or sending email", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));
  mount();
  const preview = await screen.findByRole("button", { name: "Preview Order received" });
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ preview: true, subject: "Order received", text: "Your order was created. Sample only." }), { status: 200 }));
  await userEvent.setup().click(preview);
  expect(await screen.findByText("Your order was created. Sample only.")).toBeInTheDocument();
  expect(fetch).toHaveBeenLastCalledWith("/api/settings/email-notifications/order.received.customer/preview", expect.objectContaining({ credentials: "include" }));
  expect(screen.getByRole("switch", { name: "Order received" })).not.toBeChecked();
});
