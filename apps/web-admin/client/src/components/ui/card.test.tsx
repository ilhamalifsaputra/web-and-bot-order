import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Card } from "./card";

describe("Card", () => {
  it("renders the default variant with the raised-shell classes", () => {
    render(<Card data-testid="card">content</Card>);
    const card = screen.getByTestId("card");
    expect(card).toHaveAttribute("data-variant", "default");
    expect(card).toHaveClass("bg-card", "rounded-xl", "shadow-soft");
    expect(card).not.toHaveClass("bg-sand");
  });

  it("renders the nested variant with the recessed-panel classes", () => {
    render(
      <Card variant="nested" data-testid="card">
        content
      </Card>
    );
    const card = screen.getByTestId("card");
    expect(card).toHaveAttribute("data-variant", "nested");
    expect(card).toHaveClass("bg-sand", "rounded-lg", "shadow-none");
    expect(card).not.toHaveClass("bg-card", "shadow-soft");
  });
});
