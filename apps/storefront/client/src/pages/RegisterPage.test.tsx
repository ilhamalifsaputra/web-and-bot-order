import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import RegisterPage from "./RegisterPage";
import { publicPost } from "../api/client";

// apiGet backs AuthBrandPanel's useShopContext() (Task 16) — its response
// shape doesn't matter to this page's own behavior, only that it resolves.
vi.mock("../api/client", () => ({
  apiGet: vi.fn().mockResolvedValue({}),
  publicPost: vi.fn(),
}));

function renderRegister(initialEntry = "/register") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/register" element={<RegisterPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function fillForm() {
  fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Alice Wonderland" } });
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "alice" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "alice@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "supersecret" } });
  fireEvent.change(screen.getByLabelText("Repeat password"), { target: { value: "supersecret" } });
}

describe("RegisterPage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  it("renders fullName/username/email/password/password2 fields", () => {
    renderRegister();
    expect(screen.getByLabelText("Full name")).toBeInTheDocument();
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByLabelText("Repeat password")).toBeInTheDocument();
  });

  it("requires the fullName field — the form won't submit without it", () => {
    renderRegister();
    const fullNameInput = screen.getByLabelText("Full name") as HTMLInputElement;
    expect(fullNameInput.required).toBe(true);
    expect(fullNameInput.minLength).toBe(2);
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "alice" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "alice@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "supersecret" } });
    fireEvent.change(screen.getByLabelText("Repeat password"), { target: { value: "supersecret" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    // jsdom enforces the `required` attribute: an invalid form blocks submit,
    // so the mutation never fires.
    expect(publicPost).not.toHaveBeenCalled();
  });

  it("renders the 400 error key from the API via Flash", async () => {
    renderRegister();
    (publicPost as Mock).mockRejectedValue(new Error("web.register_username_invalid"));
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(
      await screen.findByText("Username must be 3–32 characters: lowercase letters, numbers, underscores."),
    ).toBeInTheDocument();
  });

  it("calls window.location.assign with the redirect, marked so the landing page can confirm success (T5)", async () => {
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { assign },
    });
    renderRegister();
    (publicPost as Mock).mockResolvedValue({ redirect: "/account" });
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/account?welcome=1"));
  });

  it("appends the welcome marker with & when the redirect already carries a query string", async () => {
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { assign },
    });
    renderRegister();
    (publicPost as Mock).mockResolvedValue({ redirect: "/cart?promo=1" });
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/cart?promo=1&welcome=1"));
  });

  it("preserves ref/next from the URL into the POST body", async () => {
    renderRegister("/register?next=%2Fcart&ref=ABCDEFG");
    (publicPost as Mock).mockResolvedValue({ redirect: "/cart" });
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() =>
      expect(publicPost).toHaveBeenCalledWith("/api/v1/auth/register", {
        fullName: "Alice Wonderland",
        username: "alice",
        email: "alice@example.com",
        password: "supersecret",
        password2: "supersecret",
        ref: "ABCDEFG",
        next: "/cart",
      }),
    );
  });

  it("shows the 8-character password hint, matching the username hint's style/position (T10)", () => {
    renderRegister();
    const hint = screen.getByText("At least 8 characters.");
    expect(hint).toHaveClass("text-xs", "text-ink-faint");
  });

  it("links Terms and Privacy near the submit button without a required checkbox (T11)", () => {
    renderRegister();
    // Scoped to the <form>: Task 16's AuthBrandPanel also links Terms &
    // Privacy (its policy-link row), so an unscoped query would now match
    // two elements with the same accessible name.
    const form = screen.getByRole("button", { name: "Create account" }).closest("form")!;
    expect(within(form).getByRole("link", { name: "Terms & Conditions" })).toHaveAttribute("href", "/terms");
    expect(within(form).getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  // Task 16: the page now shares its <main> with AuthBrandPanel — no longer
  // a bare card floating on an empty background. The panel's Terms/Privacy
  // links intentionally duplicate the inline consent notice above (T11);
  // Refund is new to this page.
  it("renders the brand panel's trust strip and policy links", () => {
    renderRegister();
    expect(screen.getByText("Instant delivery")).toBeInTheDocument();
    expect(screen.getByText("QRIS & USDT")).toBeInTheDocument();
    expect(screen.getByText("Warranty per plan")).toBeInTheDocument();
    expect(screen.getByText("Help via support ticket")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Refund Policy" })).toHaveAttribute("href", "/refund");
  });
});
