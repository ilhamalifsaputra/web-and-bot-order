import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
    // Only the icon right after the spinner (the leading one) is hidden.
    expect(button).toHaveClass("[&>[data-slot=spinner]+svg]:hidden");
    expect(button).not.toHaveClass("[&>svg:not([data-slot=spinner])]:hidden");
  });

  it("keeps a trailing icon visible while pending", () => {
    render(<Button pending>Next<Check data-testid="trail" /></Button>);
    const button = screen.getByRole("button", { name: "Next" });
    expect(button.firstElementChild).toHaveAttribute("data-slot", "spinner");
    expect(button.lastElementChild).toHaveAttribute("data-testid", "trail");
    expect(button).not.toHaveClass("[&>svg:not([data-slot=spinner])]:hidden");
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
