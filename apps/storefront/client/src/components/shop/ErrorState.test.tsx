import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ErrorState from "./ErrorState";

function renderS(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("ErrorState", () => {
  it("shows friendly default copy, not a raw error", () => {
    renderS(<ErrorState />);
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText(/couldn't load this page/i)).toBeInTheDocument();
  });

  it("renders exactly the caller-supplied copy when given", () => {
    renderS(
      <ErrorState title="We couldn't load your orders" description="Your connection may have dropped." />,
    );
    expect(screen.getByText("We couldn't load your orders")).toBeInTheDocument();
    expect(screen.getByText("Your connection may have dropped.")).toBeInTheDocument();
    // nothing resembling a stack trace / status code leaks through
    expect(screen.queryByText(/Error:|status code|stack|at .*\.tsx/i)).not.toBeInTheDocument();
  });

  it("renders a retry button that fires onRetry", () => {
    const onRetry = vi.fn();
    renderS(<ErrorState onRetry={onRetry} />);
    const btn = screen.getByRole("button", { name: "Try again" });
    fireEvent.click(btn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("falls back to a reload link when no onRetry is given", () => {
    renderS(<ErrorState />);
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Reload page" })).toBeInTheDocument();
  });

  it("uses the danger tone (icon tinted rust)", () => {
    const { container } = renderS(<ErrorState />);
    expect(container.querySelector("svg")).toHaveClass("text-rust");
  });
});
