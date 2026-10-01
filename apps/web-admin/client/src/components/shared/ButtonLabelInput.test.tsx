import "@testing-library/jest-dom";
import { useState } from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ButtonLabelInput } from "./ButtonLabelInput";
import { buttonNameBudget } from "../../lib/buttonLimits";

function Harness({ kind = "category", initial = "", emoji }: { kind?: Parameters<typeof ButtonLabelInput>[0]["kind"]; initial?: string; emoji?: boolean }) {
  const [value, setValue] = useState(initial);
  return <ButtonLabelInput kind={kind} emoji={emoji} aria-label="Name" value={value} onChange={(e) => setValue(e.target.value)} />;
}

const counter = () => screen.getByTestId("button-label-counter");

describe("ButtonLabelInput", () => {
  it("shows the hint with the budget and links it to the input", () => {
    render(<Harness kind="category" />);
    const input = screen.getByLabelText("Name");
    const hint = screen.getByText(/Telegram/);
    expect(hint).toHaveTextContent(String(buttonNameBudget("category")));
    expect(input.getAttribute("aria-describedby")).toContain(hint.id);
    expect(counter()).toHaveTextContent("0/18");
  });

  it("makes the counter a polite live region", () => {
    render(<Harness />);
    expect(counter()).toHaveAttribute("aria-live", "polite");
  });

  it("counts cells: an emoji and a CJK character count as 2", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByLabelText("Name"), "Ab💎你");
    expect(counter()).toHaveTextContent("6/18");
  });

  it("ignores surrounding and repeated whitespace like the bot does", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByLabelText("Name"), "  a   b ");
    expect(counter()).toHaveTextContent("3/18");
  });

  it("stays quiet at the budget and warns (amber, not an error) one cell over, without blocking input", async () => {
    const user = userEvent.setup();
    render(<Harness kind="gameRegion" />);
    const input = screen.getByLabelText("Name");
    await user.type(input, "a".repeat(18));
    expect(counter()).toHaveAttribute("data-state", "ok");
    expect(screen.queryByTestId("button-label-warning")).toBeNull();
    await user.type(input, "bcd");
    expect(counter()).toHaveTextContent("21/18");
    expect(counter()).toHaveAttribute("data-state", "over");
    expect(counter().className).toContain("text-amberx");
    expect(counter().className).not.toContain("text-rust");
    const warning = screen.getByTestId("button-label-warning");
    expect(warning).toHaveTextContent(/3/);
    expect(input.getAttribute("aria-describedby")).toContain(warning.id);
    // Soft limit: nothing is truncated and no maxLength is set.
    expect(input).toHaveValue("a".repeat(18) + "bcd");
    expect(input).not.toHaveAttribute("maxlength");
  });

  it("subtracts the emoji prefix from the budget when asked", () => {
    render(<Harness kind="category" emoji initial="a" />);
    expect(counter()).toHaveTextContent("1/15");
  });

  it("uses the right budget for each kind", () => {
    const { rerender } = render(<ButtonLabelInput kind="productList" aria-label="Name" value="" onChange={() => {}} />);
    expect(counter()).toHaveTextContent("0/30");
    rerender(<ButtonLabelInput kind="denominationGame" aria-label="Name" value="" onChange={() => {}} />);
    expect(counter()).toHaveTextContent("0/24");
    rerender(<ButtonLabelInput kind="qtyUnit" aria-label="Name" value="" onChange={() => {}} />);
    expect(counter()).toHaveTextContent("0/16");
  });

  it("passes input props through (placeholder, className) so pages keep their layout", () => {
    render(<ButtonLabelInput kind="gameRegion" aria-label="Region" placeholder="e.g. Global" className="mt-1" value="" onChange={() => {}} />);
    expect(screen.getByPlaceholderText("e.g. Global")).toHaveClass("mt-1");
  });
});
