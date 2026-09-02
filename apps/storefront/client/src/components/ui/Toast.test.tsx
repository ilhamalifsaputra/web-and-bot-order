import "@testing-library/jest-dom";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import Toast from "./Toast";

afterEach(() => {
  vi.useRealTimers();
});

describe("Toast", () => {
  it("renders a polite live region with the message", () => {
    render(<Toast text="Ticket created" onDismiss={() => {}} />);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveTextContent("Ticket created");
  });

  it("shows no message body when text is null", () => {
    render(<Toast text={null} onDismiss={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("auto-dismisses after durationMs", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Toast text="bye" onDismiss={onDismiss} durationMs={2500} />);
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("error kind uses the rust tone classes", () => {
    render(<Toast text="failed" onDismiss={() => {}} kind="error" />);
    // the animated inner banner carries the tone classes
    expect(screen.getByText("failed").closest("div")).toHaveClass("bg-rust-tint");
  });
});
