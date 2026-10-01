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

  it("announces only the warning, not every keystroke of the counter", async () => {
    const user = userEvent.setup();
    render(<Harness kind="gameRegion" />);
    // The counter itself is silent; the live region is there from the start so crossing the limit is announced.
    expect(counter()).not.toHaveAttribute("aria-live");
    expect(counter().closest("[aria-live]")).toBeNull();
    const announcer = screen.getByTestId("button-label-announcer");
    expect(announcer).toHaveAttribute("aria-live", "polite");
    expect(announcer).toBeEmptyDOMElement();
    await user.type(screen.getByLabelText("Name"), "a".repeat(19));
    expect(announcer).toContainElement(screen.getByTestId("button-label-warning"));
    expect(counter().closest("[aria-live]")).toBeNull();
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

  it("does not claim a plan label is cut at the two-per-row budget: the bot cuts at 24", async () => {
    const user = userEvent.setup();
    render(<Harness kind="denominationPlan" />);
    expect(screen.getByText(/so two buttons fit side by side/i)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Name"), "a".repeat(20));
    const warning = screen.getByTestId("button-label-warning");
    expect(warning).toHaveTextContent("2 over");
    expect(warning).toHaveTextContent(/side by side/i);
    expect(warning).toHaveTextContent(/cuts .* beyond 24 characters/i);
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

  describe("Game Top-Up denomination name", () => {
    const Game = ({ initial, productName = "Mobile Legends", builtFromQuantity }: { initial: string; productName?: string; builtFromQuantity?: boolean }) => {
      const [value, setValue] = useState(initial);
      return <ButtonLabelInput kind="denominationGame" productName={productName} builtFromQuantity={builtFromQuantity} aria-label="Name" value={value} onChange={(e) => setValue(e.target.value)} />;
    };

    it("does not count the product name the bot drops from the start of the name", () => {
      // "Mobile Legends Event Gift Pack 1 Diamonds" is 41 cells raw, 26 without the game name.
      render(<Game initial="Mobile Legends Event Gift Pack 1 Diamonds" />);
      expect(counter()).toHaveTextContent("26/24");
      expect(counter()).toHaveAttribute("data-state", "over");
    });
    it("stays quiet for a typical supplier name that the bot shows whole once the game name is dropped", () => {
      render(<Game initial="Mobile Legends 86 Diamonds" />);
      expect(counter()).toHaveTextContent("11/24");
      expect(counter()).toHaveAttribute("data-state", "ok");
      expect(screen.queryByTestId("button-label-warning")).toBeNull();
    });
    it("also drops the product name written without its (Region) suffix, ignoring case", () => {
      render(<Game productName="Where Winds Meet (Global)" initial="where winds meet 60 Echo Beads" />);
      expect(counter()).toHaveTextContent("13/24");
    });
    it("says in the hint that the game name at the start is not counted", () => {
      render(<Game initial="" />);
      expect(screen.getByText(/game name at the start is not counted/i)).toBeInTheDocument();
    });
    it("measures the whole name when the page does not know the product name yet", () => {
      render(<ButtonLabelInput kind="denominationGame" aria-label="Name" value="Mobile Legends 86 Diamonds" onChange={() => {}} />);
      expect(counter()).toHaveTextContent("26/24");
      expect(screen.queryByText(/game name at the start is not counted/i)).toBeNull();
    });
    it("shows a neutral note instead of a counter or warning when the button is built from quantity and unit", () => {
      render(<Game initial="Mobile Legends Event Gift Pack 1 Diamonds And A Lot More Supplier Words" builtFromQuantity />);
      expect(screen.queryByTestId("button-label-counter")).toBeNull();
      expect(screen.queryByTestId("button-label-warning")).toBeNull();
      const note = screen.getByTestId("button-label-note");
      expect(note).toHaveTextContent(/quantity and unit/i);
      expect(note.className).not.toContain("text-amberx");
      expect(screen.getByLabelText("Name").getAttribute("aria-describedby")).toContain(note.id);
    });
    it("keeps the product-name rule for other kinds out of the way", () => {
      render(<ButtonLabelInput kind="productList" productName="Mobile Legends" aria-label="Name" value="Mobile Legends 86" onChange={() => {}} />);
      expect(counter()).toHaveTextContent("17/30");
    });
  });
});
