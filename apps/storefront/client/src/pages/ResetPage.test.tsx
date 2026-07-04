import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ResetPage from "./ResetPage";
import { publicPost } from "../api/client";

vi.mock("../api/client", () => ({
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

function fillForm(password: string, password2: string) {
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
  fireEvent.change(screen.getByLabelText("Repeat password"), { target: { value: password2 } });
}

describe("ResetPage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  it("renders the password/password2 fields", () => {
    renderReset();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByLabelText("Repeat password")).toBeInTheDocument();
  });

  it("renders the short-password error from the API via Flash", async () => {
    renderReset();
    (publicPost as Mock).mockRejectedValue(new Error("web.register_password_short"));
    fillForm("short1", "short1");
    fireEvent.click(screen.getByRole("button", { name: "Save new password" }));
    expect(await screen.findByText("Password must be at least 8 characters.")).toBeInTheDocument();
  });

  it("renders the mismatch error from the API via Flash", async () => {
    renderReset();
    (publicPost as Mock).mockRejectedValue(new Error("web.register_password_mismatch"));
    fillForm("password1", "password2");
    fireEvent.click(screen.getByRole("button", { name: "Save new password" }));
    expect(await screen.findByText("Passwords don't match.")).toBeInTheDocument();
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
    fillForm("password1", "password1");
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
