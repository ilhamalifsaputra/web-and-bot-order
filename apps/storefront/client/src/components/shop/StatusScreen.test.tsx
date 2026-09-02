import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Receipt } from "lucide-react";
import StatusScreen from "./StatusScreen";

function renderS(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("StatusScreen", () => {
  it("renders the icon (hidden from AT), the title and the description", () => {
    const { container } = renderS(
      <StatusScreen icon={Receipt} title="A title" description="Some explanation." />,
    );
    expect(screen.getByText("A title")).toBeInTheDocument();
    expect(screen.getByText("Some explanation.")).toBeInTheDocument();
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("renders a primary Link action and a secondary ghost action", () => {
    renderS(
      <StatusScreen
        icon={Receipt}
        title="t"
        action={{ label: "Go home", to: "/" }}
        secondaryAction={{ label: "Help", href: "/how-to-order" }}
      />,
    );
    expect(screen.getByRole("link", { name: "Go home" })).toHaveAttribute("href", "/");
    const help = screen.getByRole("link", { name: "Help" });
    expect(help).toHaveAttribute("href", "/how-to-order");
    expect(help).toHaveClass("btn", "btn-ghost");
  });

  it("renders an in-place action (no destination) as a button that fires onClick", () => {
    const onClick = vi.fn();
    renderS(<StatusScreen icon={Receipt} title="t" action={{ label: "Retry", onClick }} />);
    const btn = screen.getByRole("button", { name: "Retry" });
    expect(btn).toHaveClass("btn", "btn-primary");
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders no action row when neither action is given", () => {
    renderS(<StatusScreen icon={Receipt} title="t" />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("tone=danger tints the icon rust; neutral keeps it ink-faint", () => {
    const { container, rerender } = renderS(<StatusScreen icon={Receipt} title="t" tone="danger" />);
    expect(container.querySelector("svg")).toHaveClass("text-rust");
    rerender(
      <MemoryRouter>
        <StatusScreen icon={Receipt} title="t" />
      </MemoryRouter>,
    );
    expect(container.querySelector("svg")).toHaveClass("text-ink-faint");
  });

  it("non-bare wraps the card in the centred floor-height box; bare drops it", () => {
    const { container, rerender } = renderS(<StatusScreen icon={Receipt} title="t" />);
    expect(container.querySelector(".min-h-\\[360px\\]")).toBeInTheDocument();
    expect(container.querySelector(".card")).toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <StatusScreen icon={Receipt} title="t" bare />
      </MemoryRouter>,
    );
    expect(container.querySelector(".min-h-\\[360px\\]")).not.toBeInTheDocument();
    expect(container.querySelector(".card")).not.toBeInTheDocument();
  });

  it("renders children as a sibling of the card", () => {
    renderS(
      <StatusScreen icon={Receipt} title="t">
        <p>extra shelf content</p>
      </StatusScreen>,
    );
    expect(screen.getByText("extra shelf content")).toBeInTheDocument();
  });
});
