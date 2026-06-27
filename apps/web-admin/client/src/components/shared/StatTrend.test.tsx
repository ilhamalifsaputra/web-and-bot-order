import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatTrend } from "./StatTrend";

describe("StatTrend", () => {
  it("renders a positive percentage in the up-trend color", () => {
    const { container } = render(<StatTrend pct="12.3" />);
    expect(screen.getByText(/12\.3%/)).toBeInTheDocument();
    expect(container.querySelector(".text-grass")).not.toBeNull();
  });

  it("renders a negative percentage in the down-trend color", () => {
    const { container } = render(<StatTrend pct="-4.5" />);
    expect(screen.getByText(/-4\.5%/)).toBeInTheDocument();
    expect(container.querySelector(".text-rust")).not.toBeNull();
  });

  it("renders nothing when pct is null", () => {
    const { container } = render(<StatTrend pct={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
