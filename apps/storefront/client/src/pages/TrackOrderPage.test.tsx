import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TrackOrderPage from "./TrackOrderPage";
import { publicPost } from "../api/client";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  publicPost: vi.fn(),
}));

function renderTrack() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/track"]}>
        <Routes>
          <Route path="/track" element={<TrackOrderPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Fill both fields and submit — the page's only interaction. */
function submitLookup(code = "ord123", email = "guest@example.com"): void {
  fireEvent.change(screen.getByLabelText("Order code"), { target: { value: code } });
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: "Find my order" }));
}

describe("TrackOrderPage", () => {
  let originalLocation: PropertyDescriptor | undefined;
  let assign: Mock;

  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
    originalLocation = Object.getOwnPropertyDescriptor(window, "location");
    assign = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, writable: true, value: { assign } });
  });

  afterEach(() => {
    if (originalLocation) Object.defineProperty(window, "location", originalLocation);
  });

  it("opens with the form and an explanation of what to enter", async () => {
    renderTrack();
    expect(screen.getByRole("heading", { name: "Track your order" })).toBeInTheDocument();
    expect(screen.getByText(/order code from your confirmation email/)).toBeInTheDocument();
    expect(screen.getByLabelText("Order code")).toBeInTheDocument();
    expect(screen.getByLabelText("Email address")).toBeInTheDocument();
  });

  it("posts the code and email to /api/v1/track and leaves for the redirect it answers with", async () => {
    (publicPost as Mock).mockResolvedValue({ redirect: "/account/orders/ORD123", csrf_token: "fresh" });
    renderTrack();
    submitLookup();

    await waitFor(() =>
      expect(publicPost).toHaveBeenCalledWith("/api/v1/track", {
        order_code: "ORD123",
        email: "guest@example.com",
      }),
    );
    // Full page load, not navigate(): the shell must re-render so the app
    // sees the session this call just established.
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/account/orders/ORD123"));
  });

  it("says nothing about WHY a lookup failed, and names the next step", async () => {
    (publicPost as Mock).mockRejectedValue(new Error("web.track_not_found"));
    renderTrack();
    submitLookup();

    expect(await screen.findByText("We couldn't open that order")).toBeInTheDocument();
    const message = screen.getByText(/didn't match anything we can open/);
    expect(message).toBeInTheDocument();
    // The server answers every cause with one identical 404 so an order code
    // can't be guessed; the UI must not leak more than the server does.
    for (const leak of [/order code.*not found/i, /no such order/i, /wrong email/i, /email.*incorrect/i]) {
      expect(message.textContent).not.toMatch(leak);
    }
    // A dead end otherwise: the form is still there to retry, and the empty
    // state points somewhere for a buyer who has no idea what to fix.
    expect(screen.getByLabelText("Order code")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Help center" })).toHaveAttribute("href", "/account/support");
  });

  it("tells a throttled visitor it was too many attempts, not that the order is missing", async () => {
    (publicPost as Mock).mockRejectedValue(new Error("error.rate_limited"));
    renderTrack();
    submitLookup();

    expect(await screen.findByText("Too many attempts")).toBeInTheDocument();
    expect(screen.getByText("Too many attempts — wait a moment, then try again.")).toBeInTheDocument();
    expect(screen.queryByText("We couldn't open that order")).not.toBeInTheDocument();
  });

  it("falls back to a plain apology rather than printing a raw server string", async () => {
    (publicPost as Mock).mockRejectedValue(new Error("/api/v1/track failed 500"));
    renderTrack();
    submitLookup();

    expect(await screen.findByText("Something went wrong. Please try again.")).toBeInTheDocument();
    expect(screen.queryByText("/api/v1/track failed 500")).not.toBeInTheDocument();
  });

  it("keeps the submit button inert until both fields are filled", () => {
    renderTrack();
    const submit = screen.getByRole("button", { name: "Find my order" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Order code"), { target: { value: "ORD1" } });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "a@b.com" } });
    expect(submit).not.toBeDisabled();
  });
});
