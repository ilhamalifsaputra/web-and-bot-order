import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import Tabs, { type TabItem } from "./Tabs";

const ITEMS: TabItem[] = [
  { value: "a", label: "Termurah" },
  { value: "b", label: "Membership" },
  { value: "c", label: "Diamonds" },
];

describe("Tabs", () => {
  it("renders a tablist with one selected tab (uncontrolled, defaults to first)", () => {
    render(<Tabs items={ITEMS} aria-label="Sort" />);
    expect(screen.getByRole("tablist", { name: "Sort" })).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[0]).toHaveAttribute("tabindex", "0");
    expect(tabs[1]).toHaveAttribute("aria-selected", "false");
    expect(tabs[1]).toHaveAttribute("tabindex", "-1");
  });

  it("honors defaultValue", () => {
    render(<Tabs items={ITEMS} defaultValue="b" aria-label="x" />);
    expect(screen.getByRole("tab", { name: "Membership" })).toHaveAttribute("aria-selected", "true");
  });

  it("click selects a tab and applies the active pill classes", () => {
    render(<Tabs items={ITEMS} aria-label="x" />);
    const membership = screen.getByRole("tab", { name: "Membership" });
    fireEvent.click(membership);
    expect(membership).toHaveAttribute("aria-selected", "true");
    expect(membership).toHaveClass("bg-pine-tint", "text-pine-dark");
    expect(screen.getByRole("tab", { name: "Termurah" })).toHaveClass("bg-sand", "text-ink-soft");
  });

  it("ArrowRight / ArrowLeft roves selection and focus, with wrap", () => {
    render(<Tabs items={ITEMS} aria-label="x" />);
    const list = screen.getByRole("tablist");
    const [a, b, c] = screen.getAllByRole("tab");

    a!.focus();
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(b).toHaveAttribute("aria-selected", "true");
    expect(b).toHaveFocus();

    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(c).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(a).toHaveAttribute("aria-selected", "true"); // wrapped

    fireEvent.keyDown(list, { key: "ArrowLeft" });
    expect(c).toHaveAttribute("aria-selected", "true"); // wrapped back
  });

  it("Home / End jump to the ends", () => {
    render(<Tabs items={ITEMS} defaultValue="b" aria-label="x" />);
    const list = screen.getByRole("tablist");
    fireEvent.keyDown(list, { key: "End" });
    expect(screen.getByRole("tab", { name: "Diamonds" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(list, { key: "Home" });
    expect(screen.getByRole("tab", { name: "Termurah" })).toHaveAttribute("aria-selected", "true");
  });

  it("skips a disabled tab during arrow navigation", () => {
    const items: TabItem[] = [
      { value: "a", label: "A" },
      { value: "b", label: "B", disabled: true },
      { value: "c", label: "C" },
    ];
    render(<Tabs items={items} aria-label="x" />);
    const list = screen.getByRole("tablist");
    screen.getByRole("tab", { name: "A" }).focus();
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "C" })).toHaveAttribute("aria-selected", "true");
  });

  it("controlled: selection is driven by the value prop, onValueChange fires", () => {
    const onValueChange = vi.fn();
    function Controlled() {
      const [v, setV] = useState("a");
      return (
        <Tabs
          items={ITEMS}
          value={v}
          onValueChange={(next) => {
            onValueChange(next);
            setV(next);
          }}
          aria-label="x"
        />
      );
    }
    render(<Controlled />);
    fireEvent.click(screen.getByRole("tab", { name: "Diamonds" }));
    expect(onValueChange).toHaveBeenCalledWith("c");
    expect(screen.getByRole("tab", { name: "Diamonds" })).toHaveAttribute("aria-selected", "true");
  });

  it("controlled without a state update does NOT move the selection", () => {
    const onValueChange = vi.fn();
    render(<Tabs items={ITEMS} value="a" onValueChange={onValueChange} aria-label="x" />);
    fireEvent.click(screen.getByRole("tab", { name: "Membership" }));
    expect(onValueChange).toHaveBeenCalledWith("b");
    expect(screen.getByRole("tab", { name: "Termurah" })).toHaveAttribute("aria-selected", "true");
  });

  it("panels mode renders a wired tabpanel", () => {
    render(
      <Tabs
        items={ITEMS}
        aria-label="x"
        panels={{ a: <div>Panel A</div>, b: <div>Panel B</div>, c: <div>Panel C</div> }}
      />,
    );
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveTextContent("Panel A");
    const selectedTab = screen.getByRole("tab", { name: "Termurah" });
    expect(selectedTab).toHaveAttribute("aria-controls", panel.getAttribute("id"));
    expect(panel).toHaveAttribute("aria-labelledby", selectedTab.getAttribute("id"));

    fireEvent.click(screen.getByRole("tab", { name: "Membership" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Panel B");
  });
});
