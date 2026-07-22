import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import Callout from "./Callout";

describe("Callout", () => {
  it("renders the info icon for the info variant", () => {
    const { container } = render(<Callout variant="info">Data leaves only on request.</Callout>);
    expect(screen.getByText("Data leaves only on request.")).toBeInTheDocument();
    expect(container.querySelector("svg.lucide-info")).toBeInTheDocument();
  });

  it("renders the tip icon for the tip variant", () => {
    const { container } = render(<Callout variant="tip">Full refund, nothing deducted.</Callout>);
    expect(screen.getByText("Full refund, nothing deducted.")).toBeInTheDocument();
    expect(container.querySelector("svg.lucide-lightbulb")).toBeInTheDocument();
  });

  it("renders the warning icon for the warning variant", () => {
    const { container } = render(<Callout variant="warning">Wrong network loses the funds.</Callout>);
    expect(screen.getByText("Wrong network loses the funds.")).toBeInTheDocument();
    expect(container.querySelector("svg.lucide-triangle-alert")).toBeInTheDocument();
  });
});
