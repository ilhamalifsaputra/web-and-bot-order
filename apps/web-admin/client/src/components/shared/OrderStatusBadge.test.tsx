import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { OrderStatusBadge } from "./OrderStatusBadge";

describe("OrderStatusBadge", () => {
  it("renders the Awaiting bucket (amber, clock icon) for a pending-payment-family status", () => {
    const { container } = render(<OrderStatusBadge status="PENDING_VERIFICATION" />);
    expect(screen.getByText("Pending Verification")).toBeInTheDocument();
    expect(container.querySelector(".bg-amberx-tint")).not.toBeNull();
    expect(container.querySelector("svg.lucide-clock")).not.toBeNull();
  });

  it("renders the Processing bucket (blue/pine, refresh icon) for CONFIRMED/PAID", () => {
    const { container: confirmed } = render(<OrderStatusBadge status="CONFIRMED" />);
    expect(screen.getByText("Confirmed")).toBeInTheDocument();
    expect(confirmed.querySelector(".bg-pine-tint")).not.toBeNull();
    expect(confirmed.querySelector("svg.lucide-refresh-cw")).not.toBeNull();

    const { container: paid } = render(<OrderStatusBadge status="PAID" />);
    expect(screen.getByText("Paid")).toBeInTheDocument();
    expect(paid.querySelector(".bg-pine-tint")).not.toBeNull();
  });

  it("renders the Awaiting Fulfillment bucket for raw status PROCESSING — shares amber with Awaiting but a distinct icon and its own label", () => {
    const { container } = render(<OrderStatusBadge status="PROCESSING" />);
    // orderStatusLabel("PROCESSING") is "Processing" — the granular admin label,
    // not the "Awaiting Fulfillment" bucket name.
    expect(screen.getByText("Processing")).toBeInTheDocument();
    expect(container.querySelector(".bg-amberx-tint")).not.toBeNull();
    expect(container.querySelector("svg.lucide-package-search")).not.toBeNull();
    expect(container.querySelector("svg.lucide-clock")).toBeNull();
  });

  it("renders the Delivered bucket (green/grass, check icon)", () => {
    const { container } = render(<OrderStatusBadge status="DELIVERED" />);
    expect(screen.getByText("Delivered")).toBeInTheDocument();
    expect(container.querySelector(".bg-grass-tint")).not.toBeNull();
    expect(container.querySelector("svg.lucide-circle-check")).not.toBeNull();
  });

  it("renders the Cancelled bucket (red/rust, x-circle icon) for CANCELLED and REJECTED", () => {
    const { container: cancelled } = render(<OrderStatusBadge status="CANCELLED" />);
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(cancelled.querySelector(".bg-rust-tint")).not.toBeNull();
    expect(cancelled.querySelector("svg.lucide-circle-x")).not.toBeNull();

    const { container: rejected } = render(<OrderStatusBadge status="REJECTED" />);
    expect(screen.getByText("Rejected")).toBeInTheDocument();
    expect(rejected.querySelector(".bg-rust-tint")).not.toBeNull();
    expect(rejected.querySelector("svg.lucide-circle-x")).not.toBeNull();
  });

  it("renders the Refunded bucket (neutral gray/sand, undo icon)", () => {
    const { container } = render(<OrderStatusBadge status="REFUNDED" />);
    expect(screen.getByText("Refunded")).toBeInTheDocument();
    expect(container.querySelector(".bg-sand")).not.toBeNull();
    expect(container.querySelector("svg.lucide-undo-2")).not.toBeNull();
  });

  it("renders the Failed bucket — same rust hue as Cancelled, different icon", () => {
    const { container } = render(<OrderStatusBadge status="FAILED" />);
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(container.querySelector(".bg-rust-tint")).not.toBeNull();
    expect(container.querySelector("svg.lucide-triangle-alert")).not.toBeNull();
    expect(container.querySelector("svg.lucide-circle-x")).toBeNull();
  });

  it("falls back to neutral styling and the raw string for an unmapped status", () => {
    const { container } = render(<OrderStatusBadge status="SOME_NEW_STATUS" />);
    expect(screen.getByText("SOME_NEW_STATUS")).toBeInTheDocument();
    expect(container.querySelector(".bg-sand")).not.toBeNull();
  });
});
