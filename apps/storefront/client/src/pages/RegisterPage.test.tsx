import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import RegisterPage from "./RegisterPage";
import { publicPost } from "../api/client";

vi.mock("../api/client", () => ({
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
  fireEvent.change(screen.getByLabelText("Full Name"), { target: { value: "Alice Wonderland" } });
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
    expect(screen.getByLabelText("Full Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByLabelText("Repeat password")).toBeInTheDocument();
  });

  it("requires the fullName field — the form won't submit without it", () => {
    renderRegister();
    const fullNameInput = screen.getByLabelText("Full Name") as HTMLInputElement;
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

  it("calls window.location.assign with the redirect on success", async () => {
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
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/account"));
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
});
