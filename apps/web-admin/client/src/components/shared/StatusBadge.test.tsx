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

  it("uses the red tone for a banned user", () => {
    const { container } = render(<StatusBadge status="BANNED" />);
    expect(container.querySelector(".bg-rust-tint")).not.toBeNull();
  });

  it("uses the red tone for out-of-stock", () => {
    const { container } = render(<StatusBadge status="OUT_OF_STOCK" />);
    expect(container.querySelector(".bg-rust-tint")).not.toBeNull();
  });

  it("uses the amber tone for low stock", () => {
    const { container } = render(<StatusBadge status="LOW_STOCK" />);
    expect(container.querySelector(".bg-amberx-tint")).not.toBeNull();
  });

  it("uses the green tone for in-stock", () => {
    const { container } = render(<StatusBadge status="IN_STOCK" />);
    expect(container.querySelector(".bg-grass-tint")).not.toBeNull();
  });

  it("uses the amber tone for a voucher expiring soon", () => {
    const { container } = render(<StatusBadge status="EXPIRING_SOON" />);
    expect(container.querySelector(".bg-amberx-tint")).not.toBeNull();
  });

  it("uses the green tone for a matched payment", () => {
    const { container } = render(<StatusBadge status="MATCHED" />);
    expect(container.querySelector(".bg-grass-tint")).not.toBeNull();
  });

  it("uses the red tone for a payment delivery failure", () => {
    const { container } = render(<StatusBadge status="DELIVERY_FAILED" />);
    expect(container.querySelector(".bg-rust-tint")).not.toBeNull();
  });

  it("uses the amber tone for an unmatched payment", () => {
    const { container } = render(<StatusBadge status="UNMATCHED" />);
    expect(container.querySelector(".bg-amberx-tint")).not.toBeNull();
  });

  it("uses the green tone for a sent outbox notification", () => {
    const { container } = render(<StatusBadge status="SENT" />);
    expect(container.querySelector(".bg-grass-tint")).not.toBeNull();
  });

  it("uses the success tone for credited to balance", () => {
    const { container } = render(<StatusBadge status="CREDITED_TO_BALANCE" />);
    expect(container.querySelector(".bg-grass-tint")).not.toBeNull();
  });

  it("uses the green tone for returning customers", () => {
    const { container } = render(<StatusBadge status="RETURNING" />);
    expect(container.querySelector(".bg-grass-tint")).not.toBeNull();
  });

  it("uses the amber tone for an open ticket", () => {
    const { container } = render(<StatusBadge status="OPEN" />);
    expect(container.querySelector(".bg-amberx-tint")).not.toBeNull();
  });

  it("uses the neutral tone for a replied ticket", () => {
    const { container } = render(<StatusBadge status="REPLIED" />);
    expect(container.querySelector(".bg-sand")).not.toBeNull();
  });

  it("uses the green tone for a resolved ticket", () => {
    const { container } = render(<StatusBadge status="RESOLVED" />);
    expect(container.querySelector(".bg-grass-tint")).not.toBeNull();
  });

  it("uses the neutral tone for a closed ticket", () => {
    const { container } = render(<StatusBadge status="CLOSED" />);
    expect(container.querySelector(".bg-sand")).not.toBeNull();
  });

  it("uses the neutral tone for low/medium ticket priority", () => {
    const low = render(<StatusBadge status="LOW" />);
    expect(low.container.querySelector(".bg-sand")).not.toBeNull();
    const medium = render(<StatusBadge status="MEDIUM" />);
    expect(medium.container.querySelector(".bg-sand")).not.toBeNull();
  });

  it("uses the amber tone for high ticket priority", () => {
    const { container } = render(<StatusBadge status="HIGH" />);
    expect(container.querySelector(".bg-amberx-tint")).not.toBeNull();
  });

  it("uses the red tone for urgent ticket priority", () => {
    const { container } = render(<StatusBadge status="URGENT" />);
    expect(container.querySelector(".bg-rust-tint")).not.toBeNull();
  });
});
