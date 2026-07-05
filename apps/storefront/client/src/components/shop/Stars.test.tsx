import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import Stars from "./Stars";

describe("Stars", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
  });

  it("fills 4 of 5 stars for a 3.5 rating (threshold is i - 0.5)", () => {
    const { container } = render(<Stars rating={3.5} />);
    const stars = container.querySelectorAll("svg");
    expect(stars).toHaveLength(5);
    const filled = Array.from(stars).filter((s) => s.classList.contains("fill-amber-400"));
    const empty = Array.from(stars).filter((s) => s.classList.contains("text-line"));
    expect(filled).toHaveLength(4);
    expect(empty).toHaveLength(1);
  });

  it("labels the rounded rating out of 5", () => {
    const { container } = render(<Stars rating={3.5} />);
    expect(container.querySelector('[aria-label="3.5/5"]')).toBeInTheDocument();
  });
});
