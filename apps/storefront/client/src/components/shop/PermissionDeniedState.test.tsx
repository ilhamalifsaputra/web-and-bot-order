import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import PermissionDeniedState from "./PermissionDeniedState";
import NotFoundState from "./NotFoundState";
import ErrorState from "./ErrorState";

function renderS(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("PermissionDeniedState", () => {
  it("shows access-denied copy distinct from Error and Not-found", () => {
    renderS(<PermissionDeniedState />);
    expect(screen.getByText("You don't have access")).toBeInTheDocument();
    expect(screen.getByText(/don't have access to this page/i)).toBeInTheDocument();
  });

  it("does not reuse the Error or Not-found headings", () => {
    const { unmount } = renderS(<ErrorState />);
    const errTitle = screen.getByText("Something went wrong").textContent;
    unmount();
    const r2 = renderS(<NotFoundState />);
    const nfTitle = screen.getByText("Page not found").textContent;
    r2.unmount();

    renderS(<PermissionDeniedState />);
    const pdTitle = screen.getByText("You don't have access").textContent;
    expect(new Set([errTitle, nfTitle, pdTitle]).size).toBe(3);
  });

  it("defaults its action to the account home", () => {
    renderS(<PermissionDeniedState />);
    expect(screen.getByRole("link", { name: "My account" })).toHaveAttribute("href", "/account");
  });

  it("accepts an override action", () => {
    renderS(<PermissionDeniedState action={{ label: "Go back", to: "/" }} />);
    expect(screen.getByRole("link", { name: "Go back" })).toHaveAttribute("href", "/");
  });
});
