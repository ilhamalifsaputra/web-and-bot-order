import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Pagination } from "./Pagination";

beforeEach(() => {
  vi.restoreAllMocks();
  // Radix Select uses pointer-capture APIs and scrollIntoView — jsdom doesn't
  // implement them. Mock all four to prevent unhandled errors when the
  // dropdown opens and focuses the first option.
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("Pagination", () => {
  it("renders the showing-range text", () => {
    render(<Pagination page={2} pageSize={20} total={45} onPageChange={() => {}} />);
    expect(screen.getByText("Showing 21–40 of 45")).toBeInTheDocument();
  });

  it("shows 'No results' instead of a 0–0 range when total is 0", () => {
    render(<Pagination page={1} pageSize={20} total={0} onPageChange={() => {}} />);
    expect(screen.getByText("No results")).toBeInTheDocument();
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
  });

  it("disables Prev on page 1", () => {
    render(<Pagination page={1} pageSize={20} total={45} onPageChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
  });

  it("disables Next on the last page", () => {
    render(<Pagination page={3} pageSize={20} total={45} onPageChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  });

  it("enables Prev/Next when not on a boundary page", () => {
    render(<Pagination page={2} pageSize={20} total={45} onPageChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Previous page" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled();
  });

  it("calls onPageChange with the clicked page number", () => {
    const onPageChange = vi.fn();
    render(<Pagination page={1} pageSize={20} total={100} onPageChange={onPageChange} />);
    const page3 = screen.getByRole("button", { name: "Go to page 3" });
    page3.click();
    expect(onPageChange).toHaveBeenCalledWith(3);
  });

  it("calls onPageChange with page - 1 / page + 1 for Prev/Next", () => {
    const onPageChange = vi.fn();
    render(<Pagination page={2} pageSize={20} total={100} onPageChange={onPageChange} />);
    screen.getByRole("button", { name: "Previous page" }).click();
    expect(onPageChange).toHaveBeenCalledWith(1);
    screen.getByRole("button", { name: "Next page" }).click();
    expect(onPageChange).toHaveBeenCalledWith(3);
  });

  it("marks the active page with aria-current", () => {
    render(<Pagination page={2} pageSize={20} total={100} onPageChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Go to page 2" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Go to page 1" })).not.toHaveAttribute("aria-current");
  });

  it("renders an ellipsis for a large page count", () => {
    render(<Pagination page={7} pageSize={20} total={400} onPageChange={() => {}} />);
    // 400 / 20 = 20 pages; window around page 7 is 5-9, first=1, last=20.
    expect(screen.getAllByText("…").length).toBe(2);
    expect(screen.getByRole("button", { name: "Go to page 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go to page 20" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go to page 5" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go to page 9" })).toBeInTheDocument();
  });

  it("does not render a page-size select when onPageSizeChange is omitted", () => {
    render(<Pagination page={1} pageSize={20} total={100} onPageChange={() => {}} />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("calls onPageSizeChange when a new page size is picked", async () => {
    const user = userEvent.setup();
    const onPageSizeChange = vi.fn();
    render(
      <Pagination
        page={1}
        pageSize={20}
        total={100}
        onPageChange={() => {}}
        onPageSizeChange={onPageSizeChange}
      />
    );
    await user.click(screen.getByRole("combobox"));
    await waitFor(() => screen.getByRole("option", { name: "50 / page" }));
    await user.click(screen.getByRole("option", { name: "50 / page" }));
    expect(onPageSizeChange).toHaveBeenCalledWith(50);
  });
});
