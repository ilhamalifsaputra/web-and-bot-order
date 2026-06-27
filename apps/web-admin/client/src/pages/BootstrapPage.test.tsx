import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { BootstrapPage } from "./BootstrapPage";

function mockFetch(body: unknown, status = 200) {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  document.head.innerHTML = '<meta name="admin-ids" content="[123456789]">';
});

describe("BootstrapPage", () => {
  it("renders bootstrap form with admin ID hint", () => {
    render(
      <MemoryRouter>
        <BootstrapPage />
      </MemoryRouter>,
    );
    expect(screen.getByText("Create admin account")).toBeInTheDocument();
    expect(screen.getByText("123456789")).toBeInTheDocument();
  });

  it("shows error on short password", async () => {
    mockFetch({ error: "Password too short." }, 400);
    render(
      <MemoryRouter>
        <BootstrapPage />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText(/telegram id/i), {
      target: { value: "123456789" },
    });
    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: "short" },
    });
    fireEvent.change(screen.getByLabelText(/confirm password/i), {
      target: { value: "short" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));
    await waitFor(() =>
      expect(screen.getByText("Password too short.")).toBeInTheDocument(),
    );
  });

  it("redirects to login on success", async () => {
    const loc = { href: "" };
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: loc,
    });
    mockFetch({ ok: true, redirect: "/login" }, 200);
    render(
      <MemoryRouter>
        <BootstrapPage />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText(/telegram id/i), {
      target: { value: "123456789" },
    });
    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: "strongpassword" },
    });
    fireEvent.change(screen.getByLabelText(/confirm password/i), {
      target: { value: "strongpassword" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));
    await waitFor(() => expect(loc.href).toBe("/login"));
  });
});
