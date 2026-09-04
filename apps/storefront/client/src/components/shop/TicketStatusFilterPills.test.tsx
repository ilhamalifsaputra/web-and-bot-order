import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TicketStatusFilterPills from "./TicketStatusFilterPills";
import type { SupportTicketStats } from "../../api/types";

const counts: SupportTicketStats = {
  all: 4,
  waiting_for_you: 1,
  waiting_for_support: 1,
  in_progress: 1,
  resolved: 1,
  closed: 0,
};

describe("TicketStatusFilterPills", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
  });

  it("renders six pills with the mapped label and its count", () => {
    render(<TicketStatusFilterPills active="all" counts={counts} onChange={vi.fn()} />);
    const pills = screen.getAllByRole("button");
    expect(pills).toHaveLength(6);
    expect(screen.getByRole("button", { name: "All (4)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Waiting for you (1)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Waiting for support (1)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "In progress (1)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resolved (1)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Closed (0)" })).toBeInTheDocument();
  });

  it("marks only the active pill with aria-pressed and the filled style", () => {
    render(<TicketStatusFilterPills active="resolved" counts={counts} onChange={vi.fn()} />);
    const active = screen.getByRole("button", { name: "Resolved (1)" });
    const inactive = screen.getByRole("button", { name: "All (4)" });
    expect(active).toHaveAttribute("aria-pressed", "true");
    expect(inactive).toHaveAttribute("aria-pressed", "false");
    expect(active.className).toContain("bg-pine");
    expect(inactive.className).not.toContain("bg-pine");
  });

  it("calls onChange with the pill's key when clicked", async () => {
    const onChange = vi.fn();
    render(<TicketStatusFilterPills active="all" counts={counts} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "In progress (1)" }));
    expect(onChange).toHaveBeenCalledWith("in_progress");
  });
});
