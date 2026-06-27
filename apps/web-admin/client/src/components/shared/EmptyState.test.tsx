import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("renders the given message", () => {
    render(<EmptyState message="Nothing to review." />);
    expect(screen.getByText("Nothing to review.")).toBeInTheDocument();
  });
});
