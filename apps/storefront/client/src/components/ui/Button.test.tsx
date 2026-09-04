import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { createRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
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
