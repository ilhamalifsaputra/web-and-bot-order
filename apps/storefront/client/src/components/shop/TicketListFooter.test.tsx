import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TicketListFooter from "./TicketListFooter";

describe("TicketListFooter", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
  });

  it("shows the 'Showing from–to of total' range", () => {
    render(<TicketListFooter page={1} pageSize={2} total={5} onPageChange={vi.fn()} />);
    expect(screen.getByText("Showing 1–2 of 5 tickets")).toBeInTheDocument();
  });

  it("disables Previous on the first page", () => {
    render(<TicketListFooter page={1} pageSize={2} total={5} onPageChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled();
  });

  it("disables Next on the last page", () => {
    render(<TicketListFooter page={3} pageSize={2} total={5} onPageChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeEnabled();
    expect(screen.getByText("Showing 5–5 of 5 tickets")).toBeInTheDocument();
  });

  it("calls onPageChange with the next page number when Next is clicked", async () => {
    const onPageChange = vi.fn();
    render(<TicketListFooter page={1} pageSize={2} total={5} onPageChange={onPageChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("hides the pager but keeps the range text for a single page", () => {
    render(<TicketListFooter page={1} pageSize={2} total={2} onPageChange={vi.fn()} />);
    expect(screen.getByText("Showing 1–2 of 2 tickets")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Previous page" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
  });

  it("shows a zero range when there are no tickets", () => {
    render(<TicketListFooter page={1} pageSize={10} total={0} onPageChange={vi.fn()} />);
    expect(screen.getByText("Showing 0–0 of 0 tickets")).toBeInTheDocument();
  });
});
