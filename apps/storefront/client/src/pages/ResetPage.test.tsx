import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ResetPage from "./ResetPage";
import { apiGet, publicPost } from "../api/client";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
  publicPost: vi.fn(),
}));

function renderReset(token = "tok123") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/reset/${token}`]}>
        <Routes>
          <Route path="/reset/:token" element={<ResetPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function fillForm(password: string, password2: string) {
  fireEvent.change(await screen.findByLabelText("Password"), { target: { value: password } });
  fireEvent.change(screen.getByLabelText("Repeat password"), { target: { value: password2 } });
}

describe("ResetPage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
    // Every test that exercises the form assumes the token checks out —
    // the invalid-on-load tests below override this per-call.
    (apiGet as Mock).mockResolvedValue({ valid: true });
  });

  it("checks the token on load, before rendering the form (T4)", async () => {
    renderReset("tok123");
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/api/v1/auth/reset/tok123/check"));
    expect(await screen.findByLabelText("Password")).toBeInTheDocument();
  });

  it("renders the password/password2 fields once the token checks out", async () => {
    renderReset();
    expect(await screen.findByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByLabelText("Repeat password")).toBeInTheDocument();
  });

  it("renders the invalid-link error instead of the form when the token check fails, with a way to /forgot", async () => {
    (apiGet as Mock).mockResolvedValue({ valid: false });
    renderReset("garbage-token");
    expect(
      await screen.findByText("This reset link is invalid or has expired — request a new one."),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    const forgotLink = screen.getByRole("link", { name: "Request a new reset link" });
    expect(forgotLink).toHaveAttribute("href", "/forgot");
  });

  it("renders the short-password error from the API via Flash", async () => {
    renderReset();
    (publicPost as Mock).mockRejectedValue(new Error("web.register_password_short"));
    await fillForm("short1", "short1");
    fireEvent.click(screen.getByRole("button", { name: "Save new password" }));
    expect(await screen.findByText("Password must be at least 8 characters.")).toBeInTheDocument();
  });

  it("renders the mismatch error from the API via Flash", async () => {
    renderReset();
    (publicPost as Mock).mockRejectedValue(new Error("web.register_password_mismatch"));
    await fillForm("password1", "password2");
    fireEvent.click(screen.getByRole("button", { name: "Save new password" }));
    expect(await screen.findByText("Passwords don't match.")).toBeInTheDocument();
  });

  it("offers a /forgot link when the submit itself hits an invalidated token", async () => {
    renderReset();
    (publicPost as Mock).mockRejectedValue(new Error("web.reset_invalid"));
    await fillForm("password1", "password1");
    fireEvent.click(screen.getByRole("button", { name: "Save new password" }));
    expect(
      await screen.findByText("This reset link is invalid or has expired — request a new one."),
    ).toBeInTheDocument();
    const forgotLink = screen.getByRole("link", { name: "Request a new reset link" });
    expect(forgotLink).toHaveAttribute("href", "/forgot");
  });

  // Task 16: the page now shares its <main> with AuthBrandPanel — no longer
  // a bare card floating on an empty background, and no longer a dead end
  // with zero route to the policies. apiGet resolves {valid:true} for every
  // call in this suite (the beforeEach mock isn't queryKey-aware), which
  // also backs the panel's useShopContext() call here — harmless, since the
  // panel only reads shop_name/logo_url off it and falls back cleanly.
  it("renders the brand panel's trust strip and policy links", async () => {
    renderReset();
    await screen.findByLabelText("Password");
    expect(screen.getByText("Automatic delivery where available")).toBeInTheDocument();
    expect(screen.getByText("QRIS & USDT")).toBeInTheDocument();
    expect(screen.getByText("Warranty per plan")).toBeInTheDocument();
    expect(screen.getByText("Help via support ticket")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Terms & Conditions" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy");
    expect(screen.getByRole("link", { name: "Refund Policy" })).toHaveAttribute("href", "/refund");
  });

  it("posts to /api/v1/auth/reset/:token and assigns /login?reset=1 on success", async () => {
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { assign },
    });
    renderReset("abc123");
    (publicPost as Mock).mockResolvedValue({ redirect: "/login?reset=1" });
    await fillForm("password1", "password1");
    fireEvent.click(screen.getByRole("button", { name: "Save new password" }));
    await waitFor(() =>
      expect(publicPost).toHaveBeenCalledWith("/api/v1/auth/reset/abc123", {
        password: "password1",
        password2: "password1",
      }),
    );
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login?reset=1"));
  });
});
