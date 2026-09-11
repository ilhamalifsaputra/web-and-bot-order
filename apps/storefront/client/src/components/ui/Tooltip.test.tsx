import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import Tooltip from "./Tooltip";

describe("Tooltip", () => {
  it("is hidden until hover/focus", () => {
    render(
      <Tooltip label="Copied to clipboard">
        <button type="button">Copy</button>
      </Tooltip>,
    );
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("shows on focus with role=tooltip and links via aria-describedby", () => {
    const { container } = render(
      <Tooltip label="Copied to clipboard">
        <button type="button">Copy</button>
      </Tooltip>,
    );
    fireEvent.focusIn(container.firstElementChild!);
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("Copied to clipboard");
    expect(screen.getByText("Copy").parentElement).toHaveAttribute(
      "aria-describedby",
      tip.getAttribute("id"),
    );
  });

  it("hides again on blur", () => {
    const { container } = render(
      <Tooltip label="Info">
        <button type="button">Copy</button>
      </Tooltip>,
    );
    fireEvent.focusIn(container.firstElementChild!);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.focusOut(container.firstElementChild!);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("shows on mouse enter and hides on mouse leave", () => {
    const { container } = render(
      <Tooltip label="Info">
        <span>trigger</span>
      </Tooltip>,
    );
    const root = container.firstElementChild!;
    fireEvent.mouseEnter(root);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.mouseLeave(root);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("Escape dismisses it", () => {
    const { container } = render(
      <Tooltip label="Info">
        <button type="button">t</button>
      </Tooltip>,
    );
    fireEvent.focusIn(container.firstElementChild!);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.keyDown(container.firstElementChild!, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
