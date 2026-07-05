import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ProgressBar } from "./ProgressBar";

describe("ProgressBar", () => {
  it("renders the fill at the given percentage width", () => {
    const { container } = render(<ProgressBar value={42} tone="grass" />);
    const fill = container.querySelector(".bg-grass") as HTMLElement;
    expect(fill.style.width).toBe("42%");
  });

  it("clamps values above 100", () => {
    const { container } = render(<ProgressBar value={150} tone="rust" />);
    const fill = container.querySelector(".bg-rust") as HTMLElement;
    expect(fill.style.width).toBe("100%");
  });

  it("clamps negative values to 0", () => {
    const { container } = render(<ProgressBar value={-10} tone="amberx" />);
    const fill = container.querySelector(".bg-amberx") as HTMLElement;
    expect(fill.style.width).toBe("0%");
  });
});
