import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryErrorNotice } from "./QueryErrorNotice";
import { BulkFailuresNotice } from "./BulkFailuresNotice";
import { ErrorBoundary } from "./ErrorBoundary";
import { SessionExpiredBanner } from "../layout/SessionExpiredBanner";
import { clearSessionExpired, markSessionExpired } from "../../api/sessionExpiry";

/**
 * Visual state standard (UI-states audit, section D): each state notice carries
 * its own state icon, hidden from assistive tech because the text says the same
 * thing, and a failure reads differently from a warning by icon as well as colour.
 */
afterEach(() => {
  cleanup();
  act(() => clearSessionExpired());
});

function stateIcon(container: HTMLElement, name: string): SVGElement | null {
  return container.querySelector(`svg.lucide-${name}`);
}

describe("QueryErrorNotice", () => {
  it("a failed first load is an error: circle-alert icon, destructive tone, hidden icon", () => {
    const { container } = render(<QueryErrorNotice what="orders" hasData={false} onRetry={vi.fn()} />);
    const notice = screen.getByRole("alert");
    const icon = stateIcon(container, "circle-alert");
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(notice).toHaveClass("text-rust");
    expect(stateIcon(container, "triangle-alert")).toBeNull();
  });

  it("a failed refresh with data on screen is a warning: triangle-alert icon, warning tone", () => {
    const { container } = render(<QueryErrorNotice what="orders" hasData onRetry={vi.fn()} />);
    const notice = screen.getByRole("status");
    const icon = stateIcon(container, "triangle-alert");
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(notice).toHaveClass("bg-amberx-tint");
    expect(notice).not.toHaveClass("text-rust");
    expect(stateIcon(container, "circle-alert")).toBeNull();
  });
});

describe("SessionExpiredBanner", () => {
  it("uses the lock-keyhole icon and the warning tone, icon hidden", () => {
    act(() => markSessionExpired());
    const { container } = render(
      <MemoryRouter initialEntries={["/orders"]}>
        <SessionExpiredBanner />
      </MemoryRouter>,
    );
    const banner = screen.getByRole("alert");
    const icon = stateIcon(container, "lock-keyhole");
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(banner).toHaveClass("bg-amberx-tint");
    expect(banner).not.toHaveClass("text-rust");
  });
});

describe("BulkFailuresNotice", () => {
  it("leads with a hidden circle-alert icon", () => {
    const { container } = render(
      <BulkFailuresNotice failures={[{ label: "ORD-1", reason: "Out of stock" }]} onDismiss={vi.fn()} />,
    );
    const icon = stateIcon(container, "circle-alert");
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveAttribute("aria-hidden", "true");
    // The dismiss button's X stays an unlabelled decoration inside a labelled button.
    expect(screen.getByRole("button", { name: "Dismiss these failures" })).toBeInTheDocument();
  });
});

describe("ErrorBoundary", () => {
  function Boom(): never {
    throw new Error("render failed");
  }

  it("announces the fallback and shows a hidden circle-alert icon", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong.");
    const icon = stateIcon(container, "circle-alert");
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveAttribute("aria-hidden", "true");
    spy.mockRestore();
  });
});
