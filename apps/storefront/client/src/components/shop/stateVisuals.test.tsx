import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import Alert from "../ui/Alert";
import ErrorBoundary from "../ErrorBoundary";
import { RefreshFailedNotice } from "./LoadFailed";

/**
 * Visual state standard (UI-states audit, section D): a failure reads
 * differently from a warning by its icon as well as its colour, and every state
 * icon is hidden from assistive tech because the text already says it.
 */
beforeEach(() => {
  document.documentElement.lang = "en";
});
afterEach(cleanup);

describe("Alert error vs warning", () => {
  it.each(["banner", "panel"] as const)("%s: error uses circle-alert, warning keeps triangle-alert", (variant) => {
    const { container: errorBox } = render(<Alert variant={variant} tone="error">Payment failed</Alert>);
    const errorIcon = errorBox.querySelector("svg.lucide-circle-alert");
    expect(errorIcon).toBeInTheDocument();
    expect(errorIcon).toHaveAttribute("aria-hidden", "true");
    expect(errorBox.querySelector("svg.lucide-triangle-alert")).toBeNull();
    cleanup();
    const { container: warningBox } = render(<Alert variant={variant} tone="warning">Check the network</Alert>);
    expect(warningBox.querySelector("svg.lucide-triangle-alert")).toHaveAttribute("aria-hidden", "true");
    expect(warningBox.querySelector("svg.lucide-circle-alert")).toBeNull();
  });
});

describe("RefreshFailedNotice", () => {
  it("shows a hidden warning icon beside the text", () => {
    const { container } = render(<RefreshFailedNotice onRetry={vi.fn()} />);
    const notice = screen.getByRole("status");
    const icon = notice.querySelector("svg.lucide-triangle-alert");
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector("svg.lucide-circle-alert")).toBeNull();
  });
});

describe("ErrorBoundary fallback", () => {
  function Boom(): never {
    throw new Error("render failed");
  }
  it("shows a hidden circle-alert icon", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<ErrorBoundary resetKey="/cart"><Boom /></ErrorBoundary>);
    const icon = screen.getByRole("alert").querySelector("svg.lucide-circle-alert");
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveAttribute("aria-hidden", "true");
    vi.restoreAllMocks();
  });
});
