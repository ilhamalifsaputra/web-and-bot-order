import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ResetPage } from "./ResetPage";

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
});

function renderReset(search = "?telegram_id=12345") {
  return render(
    <MemoryRouter initialEntries={[`/reset${search}`]}>
      <Routes>
        <Route path="/reset" element={<ResetPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText(/reset code/i), {
    target: { value: "123456" },
  });
  fireEvent.change(screen.getByLabelText(/new password/i), {
    target: { value: "newpassword" },
  });
  fireEvent.change(screen.getByLabelText(/confirm password/i), {
    target: { value: "newpassword" },
  });
  fireEvent.click(screen.getByRole("button", { name: /reset password/i }));
}

describe("ResetPage", () => {
  it("renders reset form", () => {
    renderReset();
    expect(screen.getByRole("heading", { name: "Reset password" })).toBeInTheDocument();
    expect(screen.getByLabelText(/reset code/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/new password/i)).toBeInTheDocument();
  });

  it("shows error on wrong code", async () => {
    mockFetch({ error: "Wrong code." }, 400);
    renderReset();
    fillAndSubmit();
    await waitFor(() => expect(screen.getByText("Wrong code.")).toBeInTheDocument());
  });

  it("redirects on success", async () => {
    const loc = { href: "" };
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: loc,
    });
    mockFetch({ ok: true, redirect: "/login" }, 200);
    renderReset();
    fillAndSubmit();
    await waitFor(() => expect(loc.href).toBe("/login"));
  });
});
