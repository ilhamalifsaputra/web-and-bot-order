import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "./StatusBadge";

describe("StatusBadge", () => {
  it("renders a Title-Case label for a raw status", () => {
    render(<StatusBadge status="PENDING_VERIFICATION" />);
    expect(screen.getByText("Pending Verification")).toBeInTheDocument();
  });

  it("uses the green tone for a delivered order", () => {
    const { container } = render(<StatusBadge status="DELIVERED" />);
    expect(container.querySelector(".bg-grass-tint")).not.toBeNull();
  });

  it("uses the red tone for a failed order", () => {
    const { container } = render(<StatusBadge status="FAILED" />);
    expect(container.querySelector(".bg-rust-tint")).not.toBeNull();
  });
});
