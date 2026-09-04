import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import Skeleton from "./Skeleton";

describe("Skeleton", () => {
  it("renders a decorative pulsing block and merges className", () => {
    const { container } = render(<Skeleton className="h-4 w-1/2" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el).toHaveClass("animate-pulse", "rounded-xl", "bg-sand", "h-4", "w-1/2");
    expect(el).toHaveAttribute("aria-hidden", "true");
  });
});
