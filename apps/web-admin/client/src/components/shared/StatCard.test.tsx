import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Package } from "lucide-react";
import { StatCard } from "./StatCard";

describe("StatCard", () => {
  it("renders the label and value", () => {
    render(<StatCard label="Total Orders" value={42} />);
    expect(screen.getByText("Total Orders")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("renders a skeleton instead of the value while loading", () => {
    const { container } = render(<StatCard label="Total Orders" value={42} isLoading />);
    expect(screen.queryByText("42")).not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();
  });

  it("applies a distinguishing accent class for success/warning/danger tones", () => {
    const { container: success } = render(<StatCard label="Delivered" value={1} tone="success" />);
    expect(success.querySelector(".border-l-grass")).not.toBeNull();

    const { container: warning } = render(<StatCard label="Awaiting" value={1} tone="warning" />);
    expect(warning.querySelector(".border-l-amberx")).not.toBeNull();

    const { container: danger } = render(<StatCard label="Cancelled" value={1} tone="danger" />);
    expect(danger.querySelector(".border-l-rust")).not.toBeNull();
  });

  it("does not apply a colored accent for the default neutral tone", () => {
    const { container } = render(<StatCard label="Total Orders" value={1} />);
    expect(container.querySelector(".border-l-grass, .border-l-amberx, .border-l-rust")).toBeNull();
  });

  it("fires onClick when clicked and exposes a button role", () => {
    const onClick = vi.fn();
    render(<StatCard label="Processing" value={3} onClick={onClick} />);
    const card = screen.getByRole("button");
    fireEvent.click(card);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("fires onClick on Enter and Space when focused", () => {
    const onClick = vi.fn();
    render(<StatCard label="Processing" value={3} onClick={onClick} />);
    const card = screen.getByRole("button");
    fireEvent.keyDown(card, { key: "Enter" });
    fireEvent.keyDown(card, { key: " " });
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("has no button role or tabIndex when onClick is omitted", () => {
    render(<StatCard label="Total Orders" value={1} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders an icon when provided", () => {
    render(<StatCard label="Total Orders" value={1} icon={Package} />);
    expect(document.querySelector("svg")).toBeInTheDocument();
  });
});
