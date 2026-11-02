import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { createRef, forwardRef, type ReactNode } from "react";
import { act, render, screen, fireEvent } from "@testing-library/react";
import Button from "./Button";

describe("Button", () => {
  it("composes .btn .btn-primary at size md by default, type=button", () => {
    render(<Button>Go</Button>);
    const btn = screen.getByRole("button", { name: "Go" });
    expect(btn).toHaveClass("btn", "btn-primary");
    expect(btn).not.toHaveClass("btn-sm");
    expect(btn).toHaveAttribute("type", "button");
  });

  it.each([
    ["primary", "btn-primary"],
    ["soft", "btn-soft"],
    ["ghost", "btn-ghost"],
    ["danger", "btn-danger"],
  ] as const)("variant=%s → .%s", (variant, cls) => {
    render(<Button variant={variant}>x</Button>);
    expect(screen.getByRole("button")).toHaveClass("btn", cls);
  });

  it("size=sm adds .btn-sm; fullWidth adds w-full", () => {
    render(
      <Button size="sm" fullWidth>
        x
      </Button>,
    );
    expect(screen.getByRole("button")).toHaveClass("btn-sm", "w-full");
  });

  it("honours an explicit type=submit", () => {
    render(<Button type="submit">x</Button>);
    expect(screen.getByRole("button")).toHaveAttribute("type", "submit");
  });

  it("forwards ref to the underlying <button>", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>x</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it("fires onClick, and not when disabled", () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>x</Button>);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <Button onClick={onClick} disabled>
        x
      </Button>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("passes className and native data-/aria- attributes through", () => {
    render(
      <Button className="mt-2" data-testid="cta" aria-pressed="true">
        x
      </Button>,
    );
    const btn = screen.getByTestId("cta");
    expect(btn).toHaveClass("btn", "btn-primary", "mt-2");
    expect(btn).toHaveAttribute("aria-pressed", "true");
  });
});

describe("Button pending", () => {
  it("keeps its label, shows a spinner, is disabled and busy", () => {
    render(<Button pending>Save</Button>);
    const btn = screen.getByRole("button", { name: "Save" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-busy", "true");
    expect(btn).toHaveAttribute("data-pending", "true");
    expect(btn.querySelector("span[aria-hidden='true'].rounded-full")).toBeInTheDocument();
  });

  it("swaps a leading icon for the spinner instead of showing both, keeping a trailing icon", () => {
    render(<Button pending><svg data-testid="lead" />Next<svg data-testid="trail" /></Button>);
    const btn = screen.getByRole("button", { name: "Next" });
    // The leading icon gives way to the spinner; the trailing one stays.
    expect(btn.firstElementChild).toHaveAttribute("data-slot", "spinner");
    expect(screen.queryByTestId("lead")).not.toBeInTheDocument();
    expect(screen.getByTestId("trail")).toBeInTheDocument();
  });

  it("keeps a trailing icon after the label (no CSS sibling jump over text)", () => {
    render(<Button pending>Next<svg data-testid="trail" /></Button>);
    expect(screen.getByTestId("trail")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" }).className).not.toMatch(/svg[^ ]*:hidden/);
  });

  it("does not fire clicks while pending", () => {
    const onClick = vi.fn();
    render(<Button pending onClick={onClick}>Save</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("is a normal button when not pending, and keeps an explicit disabled", () => {
    const { rerender } = render(<Button pending={false}>Save</Button>);
    const btn = screen.getByRole("button", { name: "Save" });
    expect(btn).toBeEnabled();
    expect(btn).not.toHaveAttribute("aria-busy");
    expect(btn.querySelector(".rounded-full")).not.toBeInTheDocument();
    rerender(<Button pending={false} disabled>Save</Button>);
    expect(btn).toBeDisabled();
  });

  it("never shrinks while pending: holds the idle width as a minimum", () => {
    const { rerender } = render(<Button pending={false}>Pay now</Button>);
    const btn = screen.getByRole("button", { name: "Pay now" });
    vi.spyOn(btn, "getBoundingClientRect").mockReturnValue({ width: 140 } as DOMRect);
    rerender(<Button pending={false}>Pay now</Button>);
    rerender(<Button pending>Processing…</Button>);
    expect(btn.style.minWidth).toBe("140px");
    rerender(<Button pending={false}>Pay now</Button>);
    expect(btn.style.minWidth).toBe("");
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
