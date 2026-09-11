import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { createRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import IconButton from "./IconButton";

describe("IconButton", () => {
  it("renders a ghost button with the required accessible name and square md width", () => {
    render(
      <IconButton aria-label="Close">
        <svg />
      </IconButton>,
    );
    const btn = screen.getByRole("button", { name: "Close" });
    expect(btn).toHaveClass("btn", "btn-ghost", "p-0", "w-11");
    expect(btn).not.toHaveClass("btn-sm");
  });

  it("size=sm switches to .btn-sm + w-8", () => {
    render(
      <IconButton aria-label="Close" size="sm">
        <svg />
      </IconButton>,
    );
    const btn = screen.getByRole("button", { name: "Close" });
    expect(btn).toHaveClass("btn-sm", "w-8");
    expect(btn).not.toHaveClass("w-11");
  });

  it("forwards ref and fires onClick", () => {
    const ref = createRef<HTMLButtonElement>();
    const onClick = vi.fn();
    render(
      <IconButton aria-label="Next" ref={ref} onClick={onClick}>
        <svg />
      </IconButton>,
    );
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
