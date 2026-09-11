import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import Alert from "./Alert";

describe("Alert", () => {
  it("banner + error is an assertive role=alert", () => {
    render(
      <Alert variant="banner" tone="error">
        Something broke
      </Alert>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Something broke");
  });

  it("banner + warning is also role=alert", () => {
    render(
      <Alert variant="banner" tone="warning">
        Careful
      </Alert>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("banner + info/success is a polite role=status (not alert)", () => {
    const { rerender } = render(
      <Alert variant="banner" tone="info">
        FYI
      </Alert>,
    );
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    rerender(
      <Alert variant="banner" tone="success">
        Saved
      </Alert>,
    );
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("panel is never assertive — even error/warning are role=status", () => {
    render(
      <Alert variant="panel" tone="warning">
        Wrong network loses the funds.
      </Alert>,
    );
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("role={false} emits no role attribute", () => {
    const { container } = render(
      <Alert variant="banner" tone="error" role={false}>
        No role
      </Alert>,
    );
    expect(container.firstElementChild).not.toHaveAttribute("role");
  });

  it("explicit role prop wins", () => {
    render(
      <Alert variant="panel" tone="info" role="alert">
        forced
      </Alert>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("renders a title above the message", () => {
    render(
      <Alert variant="panel" tone="info" title="Heads up">
        body copy
      </Alert>,
    );
    expect(screen.getByText("Heads up")).toBeInTheDocument();
    expect(screen.getByText("body copy")).toBeInTheDocument();
  });

  it("accepts an icon override", () => {
    const { container } = render(
      <Alert variant="banner" tone="info" icon={<span data-testid="custom-icon" />}>
        x
      </Alert>,
    );
    expect(screen.getByTestId("custom-icon")).toBeInTheDocument();
    // default lucide icon is gone
    expect(container.querySelector("svg.lucide")).not.toBeInTheDocument();
  });

  it("forwards ref and passes through className", () => {
    const ref = createRef<HTMLDivElement>();
    const { container } = render(
      <Alert ref={ref} variant="banner" tone="info" className="mt-8">
        x
      </Alert>,
    );
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
    expect(container.firstElementChild).toHaveClass("mt-8");
  });
});
