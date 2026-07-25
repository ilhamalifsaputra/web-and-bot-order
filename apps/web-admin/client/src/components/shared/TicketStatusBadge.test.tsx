import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TicketStatusBadge } from "./TicketStatusBadge";

describe("TicketStatusBadge", () => {
  it("renders the friendly label, not the raw enum", () => {
    render(<TicketStatusBadge status="OPEN" />);
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.queryByText("OPEN")).not.toBeInTheDocument();
  });

  it("renders the OPEN status with amber tone", () => {
    const { container } = render(<TicketStatusBadge status="OPEN" />);
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(container.querySelector(".bg-amberx-tint")).not.toBeNull();
    expect(container.querySelector(".text-amberx")).not.toBeNull();
  });

  it("renders the REPLIED status with pine tone and custom label", () => {
    const { container } = render(<TicketStatusBadge status="REPLIED" />);
    expect(screen.getByText("Waiting Customer")).toBeInTheDocument();
    expect(container.querySelector(".bg-pine-tint")).not.toBeNull();
    expect(container.querySelector(".text-pine-dark")).not.toBeNull();
  });

  it("renders the CLOSED status with sand tone", () => {
    const { container } = render(<TicketStatusBadge status="CLOSED" />);
    expect(screen.getByText("Closed")).toBeInTheDocument();
    expect(container.querySelector(".bg-sand")).not.toBeNull();
    expect(container.querySelector(".text-ink-soft")).not.toBeNull();
  });

  it("falls back to neutral styling and the raw string for an unmapped status", () => {
    const { container } = render(<TicketStatusBadge status="SOME_NEW_STATUS" />);
    expect(screen.getByText("SOME_NEW_STATUS")).toBeInTheDocument();
    expect(container.querySelector(".bg-sand")).not.toBeNull();
    expect(container.querySelector(".text-ink-soft")).not.toBeNull();
  });
});
