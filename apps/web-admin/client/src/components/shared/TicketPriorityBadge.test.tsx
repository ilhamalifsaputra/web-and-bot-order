import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TicketPriorityBadge } from "./TicketPriorityBadge";

describe("TicketPriorityBadge", () => {
  it("renders the friendly label, not the raw enum", () => {
    render(<TicketPriorityBadge priority="URGENT" />);
    expect(screen.getByText("Urgent")).toBeInTheDocument();
    expect(screen.queryByText("URGENT")).not.toBeInTheDocument();
  });

  it("renders the URGENT priority with rust tone", () => {
    const { container } = render(<TicketPriorityBadge priority="URGENT" />);
    expect(screen.getByText("Urgent")).toBeInTheDocument();
    expect(container.querySelector(".bg-rust-tint")).not.toBeNull();
    expect(container.querySelector(".text-rust-dark")).not.toBeNull();
  });

  it("renders the HIGH priority with amber tone", () => {
    const { container } = render(<TicketPriorityBadge priority="HIGH" />);
    expect(screen.getByText("High")).toBeInTheDocument();
    expect(container.querySelector(".bg-amberx-tint")).not.toBeNull();
    expect(container.querySelector(".text-amberx")).not.toBeNull();
  });

  it("renders the MEDIUM priority with pine tone (baseline/default)", () => {
    const { container } = render(<TicketPriorityBadge priority="MEDIUM" />);
    expect(screen.getByText("Medium")).toBeInTheDocument();
    expect(container.querySelector(".bg-pine-tint")).not.toBeNull();
    expect(container.querySelector(".text-pine-dark")).not.toBeNull();
  });

  it("renders the LOW priority with sand tone", () => {
    const { container } = render(<TicketPriorityBadge priority="LOW" />);
    expect(screen.getByText("Low")).toBeInTheDocument();
    expect(container.querySelector(".bg-sand")).not.toBeNull();
    expect(container.querySelector(".text-ink-soft")).not.toBeNull();
  });

  it("falls back to neutral styling and the raw string for an unmapped priority", () => {
    const { container } = render(<TicketPriorityBadge priority="SOME_NEW_PRIORITY" />);
    expect(screen.getByText("SOME_NEW_PRIORITY")).toBeInTheDocument();
    expect(container.querySelector(".bg-sand")).not.toBeNull();
    expect(container.querySelector(".text-ink-soft")).not.toBeNull();
  });
});
