import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { forwardRef, type ReactNode } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Check } from "lucide-react";
import { Button } from "./button";
import { Skeleton } from "./skeleton";
import { Spinner } from "./spinner";
import { LoadingRegion } from "../shared/LoadingRegion";
import { RouteFallback } from "../shared/RouteFallback";

describe("Spinner", () => {
  it("is decorative and only spins when the viewer allows motion", () => {
    const { container } = render(<Spinner />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveClass("motion-safe:animate-spin");
    expect(svg).not.toHaveClass("animate-spin");
  });
});

describe("Skeleton", () => {
  it("pulses only when the viewer allows motion and is hidden from assistive tech", () => {
    render(<Skeleton data-testid="sk" />);
    const sk = screen.getByTestId("sk");
    expect(sk).toHaveClass("motion-safe:animate-pulse");
    expect(sk).not.toHaveClass("animate-pulse");
    expect(sk).toHaveAttribute("aria-hidden", "true");
  });
});

describe("LoadingRegion", () => {
  it("is a busy status region that says what is loading", () => {
    render(<LoadingRegion label="Loading orders"><Skeleton /></LoadingRegion>);
    const region = screen.getByRole("status", { name: "Loading orders" });
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(region).toHaveTextContent("Loading orders");
    // Named by reference to its one sr-only label: no aria-label copy.
    expect(region).not.toHaveAttribute("aria-label");
    expect(region).toHaveAttribute("aria-labelledby");
    expect(screen.getAllByText("Loading orders")).toHaveLength(1);
  });
});

describe("RouteFallback", () => {
  it("is the one busy page-shaped loader for a lazy route", () => {
    render(<RouteFallback />);
    const region = screen.getByRole("status", { name: "Loading page" });
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });
});

describe("Button pending", () => {
  it("keeps its label, shows a spinner, is disabled and busy", () => {
    render(<Button pending>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("data-pending", "true");
    expect(button.querySelector("[data-slot=spinner]")).toBeInTheDocument();
  });

  it("swaps a leading icon for the spinner instead of adding a second icon", () => {
    render(<Button pending><Check data-testid="icon" />Approve</Button>);
    const button = screen.getByRole("button", { name: "Approve" });
    expect(button.firstElementChild).toHaveAttribute("data-slot", "spinner");
    expect(screen.queryByTestId("icon")).not.toBeInTheDocument();
  });

  it("keeps a trailing icon after the label while pending (no CSS sibling jump over text)", () => {
    render(<Button pending>Next<Check data-testid="trail" /></Button>);
    const button = screen.getByRole("button", { name: "Next" });
    expect(button.firstElementChild).toHaveAttribute("data-slot", "spinner");
    expect(screen.getByTestId("trail")).toBeInTheDocument();
    expect(button.className).not.toMatch(/svg[^ ]*:hidden/);
  });

  it("restores the leading icon when no longer pending", () => {
    const { rerender } = render(<Button pending><Check data-testid="icon" />Approve</Button>);
    rerender(<Button pending={false}><Check data-testid="icon" />Approve</Button>);
    expect(screen.getByTestId("icon")).toBeInTheDocument();
  });

  it("does not fire clicks while pending", async () => {
    const onClick = vi.fn();
    render(<Button pending onClick={onClick}>Save</Button>);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("is a normal button when not pending", () => {
    render(<Button pending={false}>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-busy");
    expect(button.querySelector("[data-slot=spinner]")).not.toBeInTheDocument();
  });

  it("keeps an explicit disabled when not pending", () => {
    render(<Button pending={false} disabled>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("never shrinks while pending: holds the idle width as a minimum", () => {
    const { rerender } = render(<Button pending={false}>Save changes</Button>);
    const button = screen.getByRole("button", { name: "Save changes" });
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({ width: 120 } as DOMRect);
    rerender(<Button pending={false}>Save changes</Button>);
    rerender(<Button pending>Saving…</Button>);
    expect(button.style.minWidth).toBe("120px");
    rerender(<Button pending={false}>Save changes</Button>);
    expect(button.style.minWidth).toBe("");
  });
});

describe("Button pending: leading label versus leading icon", () => {
  function PayLabel() {
    return <span>Pay</span>;
  }
  const MoneyLabel = forwardRef<HTMLSpanElement, { children: ReactNode }>(function MoneyLabel({ children }, ref) {
    return <span ref={ref}>{children}</span>;
  });
  function CoinIcon() {
    return <svg data-testid="coin" />;
  }

  it("keeps a leading function component that renders label text", () => {
    render(<Button pending><PayLabel />now</Button>);
    const btn = screen.getByRole("button");
    expect(btn.firstElementChild).toHaveAttribute("data-slot", "spinner");
    expect(screen.getByText("Pay")).toBeInTheDocument();
    expect(btn).toHaveTextContent("Paynow");
  });

  it("keeps a leading forwardRef component that carries children (a label, not an icon)", () => {
    render(<Button pending><MoneyLabel>Rp50.000</MoneyLabel> total</Button>);
    expect(screen.getByText("Rp50.000")).toBeInTheDocument();
  });

  it("still drops a leading component that is an icon by name", () => {
    render(<Button pending><CoinIcon />Top up</Button>);
    expect(screen.queryByTestId("coin")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Top up" })).toBeInTheDocument();
  });
});

describe("Button pending width with ResizeObserver", () => {
  type Report = (width: number) => void;
  let report: Report;
  let observers = 0;
  let disconnected = 0;

  beforeEach(() => {
    observers = 0;
    disconnected = 0;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          observers += 1;
          report = (width) => callback([{ borderBoxSize: [{ inlineSize: width, blockSize: 0 }] } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
        }
        observe() {}
        unobserve() {}
        disconnect() {
          disconnected += 1;
        }
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not read layout when an idle button re-renders", () => {
    const { rerender } = render(<Button pending={false}>Save</Button>);
    const btn = screen.getByRole("button", { name: "Save" });
    const measure = vi.spyOn(btn, "getBoundingClientRect");
    rerender(<Button pending={false}>Save</Button>);
    rerender(<Button pending={false}>Save</Button>);
    expect(measure).not.toHaveBeenCalled();
  });

  it("holds the width the observer last reported while pending, ignoring reports made while pending", () => {
    const { rerender } = render(<Button pending={false}>Save changes</Button>);
    const btn = screen.getByRole("button", { name: "Save changes" });
    act(() => report(120));
    rerender(<Button pending>Saving…</Button>);
    expect(btn.style.minWidth).toBe("120px");
    // The spinner swap resizes the button; that report is not the idle width.
    act(() => report(60));
    rerender(<Button pending>Saving…</Button>);
    expect(btn.style.minWidth).toBe("120px");
    rerender(<Button pending={false}>Save changes</Button>);
    expect(btn.style.minWidth).toBe("");
  });

  it("observes one element per button and disconnects when it unmounts", () => {
    const { unmount } = render(<Button>Save</Button>);
    expect(observers).toBe(1);
    unmount();
    expect(disconnected).toBe(1);
  });
});
