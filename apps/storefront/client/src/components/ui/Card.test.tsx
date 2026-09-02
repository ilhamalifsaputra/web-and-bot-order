import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import Card from "./Card";

describe("Card", () => {
  it("composes .card .card-pad by default", () => {
    render(<Card data-testid="c">body</Card>);
    expect(screen.getByTestId("c")).toHaveClass("card", "card-pad");
  });

  it("padded={false} drops .card-pad", () => {
    render(
      <Card data-testid="c" padded={false}>
        body
      </Card>,
    );
    const el = screen.getByTestId("c");
    expect(el).toHaveClass("card");
    expect(el).not.toHaveClass("card-pad");
  });

  it("interactive adds the hover elevation classes", () => {
    render(
      <Card data-testid="c" interactive>
        body
      </Card>,
    );
    expect(screen.getByTestId("c")).toHaveClass("hover:shadow-lift", "transition-shadow");
  });

  it("forwards ref and merges className", () => {
    const ref = createRef<HTMLDivElement>();
    render(
      <Card ref={ref} className="mt-4">
        body
      </Card>,
    );
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
    expect(ref.current).toHaveClass("card", "mt-4");
  });
});
