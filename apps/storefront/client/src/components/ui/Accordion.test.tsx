import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import Accordion, { type AccordionItem } from "./Accordion";

const ITEMS: AccordionItem[] = [
  { value: "ship", trigger: "How fast is delivery?", content: "Instantly after payment." },
  { value: "refund", trigger: "Can I get a refund?", content: "Yes, within 24h." },
  { value: "safe", trigger: "Is my account safe?", content: "We never store passwords." },
];

const triggerFor = (name: string) => screen.getByRole("button", { name });

describe("Accordion", () => {
  it("renders all triggers collapsed by default", () => {
    render(<Accordion items={ITEMS} />);
    for (const item of ITEMS) {
      expect(
        screen.getByRole("button", { name: item.trigger as string }),
      ).toHaveAttribute("aria-expanded", "false");
    }
  });

  it("wires aria-controls / aria-labelledby between trigger and region", () => {
    render(<Accordion items={ITEMS} />);
    const trigger = triggerFor("How fast is delivery?");
    const regionId = trigger.getAttribute("aria-controls")!;
    const region = document.getElementById(regionId)!;
    expect(region).toHaveAttribute("role", "region");
    expect(region).toHaveAttribute("aria-labelledby", trigger.getAttribute("id"));
  });

  it("respects defaultValue (single)", () => {
    render(<Accordion items={ITEMS} defaultValue="refund" />);
    expect(triggerFor("Can I get a refund?")).toHaveAttribute("aria-expanded", "true");
  });

  it("single mode: opening one row closes the previously open row", () => {
    render(<Accordion items={ITEMS} />);
    fireEvent.click(triggerFor("How fast is delivery?"));
    expect(triggerFor("How fast is delivery?")).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(triggerFor("Can I get a refund?"));
    expect(triggerFor("Can I get a refund?")).toHaveAttribute("aria-expanded", "true");
    expect(triggerFor("How fast is delivery?")).toHaveAttribute("aria-expanded", "false");
  });

  it("single + collapsible: clicking the open row closes it", () => {
    render(<Accordion items={ITEMS} />);
    fireEvent.click(triggerFor("How fast is delivery?"));
    fireEvent.click(triggerFor("How fast is delivery?"));
    expect(triggerFor("How fast is delivery?")).toHaveAttribute("aria-expanded", "false");
  });

  it("single + collapsible={false}: the open row stays open when re-clicked", () => {
    render(<Accordion items={ITEMS} collapsible={false} defaultValue="ship" />);
    fireEvent.click(triggerFor("How fast is delivery?"));
    expect(triggerFor("How fast is delivery?")).toHaveAttribute("aria-expanded", "true");
  });

  it("multiple mode: more than one row can be open at once", () => {
    render(<Accordion items={ITEMS} type="multiple" />);
    fireEvent.click(triggerFor("How fast is delivery?"));
    fireEvent.click(triggerFor("Is my account safe?"));
    expect(triggerFor("How fast is delivery?")).toHaveAttribute("aria-expanded", "true");
    expect(triggerFor("Is my account safe?")).toHaveAttribute("aria-expanded", "true");
  });

  it("controlled: value prop drives open state and onValueChange reports it", () => {
    const onValueChange = vi.fn();
    render(
      <Accordion items={ITEMS} type="multiple" value={["ship"]} onValueChange={onValueChange} />,
    );
    expect(triggerFor("How fast is delivery?")).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(triggerFor("Can I get a refund?"));
    expect(onValueChange).toHaveBeenCalledWith(["ship", "refund"]);
    // still only "ship" open — parent didn't update the prop
    expect(triggerFor("Can I get a refund?")).toHaveAttribute("aria-expanded", "false");
  });

  it("a disabled row cannot be toggled", () => {
    const items: AccordionItem[] = [
      { value: "x", trigger: "Locked", content: "nope", disabled: true },
    ];
    render(<Accordion items={items} />);
    const trigger = triggerFor("Locked");
    expect(trigger).toBeDisabled();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("shows content text and rotates the chevron on the open row", () => {
    render(<Accordion items={ITEMS} defaultValue="ship" />);
    const trigger = triggerFor("How fast is delivery?");
    expect(trigger.querySelector("svg")).toHaveClass("rotate-180");
    const region = document.getElementById(trigger.getAttribute("aria-controls")!)!;
    expect(region).toHaveTextContent("Instantly after payment.");
  });
});
