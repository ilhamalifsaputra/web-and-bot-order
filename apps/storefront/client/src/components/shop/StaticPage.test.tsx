import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ListChecks } from "lucide-react";
import StaticPage from "./StaticPage";

function renderPage(node: React.ReactElement) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

describe("StaticPage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
  });

  it("prose variant (default) renders section <h2>s and no numbered timeline", () => {
    const { container } = renderPage(<StaticPage prefix="about" blocks={4} />);

    // One h1, then one h2 per block (+ the end-of-page help CTA h2).
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "About us" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "What we sell" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "How to reach us" })).toBeInTheDocument();

    // Prose = no StepTimeline: it renders an <ol> of <li> steps, this must not.
    expect(container.querySelector("ol")).toBeNull();
    expect(container.querySelector("li")).toBeNull();

    // Forward action is kept.
    expect(screen.getByRole("link", { name: /Open a support ticket/ })).toHaveAttribute(
      "href",
      "/account/support",
    );
  });

  it("timeline variant renders the numbered StepTimeline (an <ol> of steps)", () => {
    const { container } = renderPage(
      <StaticPage
        prefix="hto"
        blocks={5}
        variant="timeline"
        steps={[{ icon: ListChecks }, { icon: ListChecks }, { icon: ListChecks }, { icon: ListChecks }, { icon: ListChecks }]}
      />,
    );

    const list = container.querySelector("ol");
    expect(list).not.toBeNull();
    expect(list!.querySelectorAll("li")).toHaveLength(5);
    // Same copy, just inside numbered badges now.
    expect(screen.getByRole("heading", { level: 1, name: "How to order" })).toBeInTheDocument();
  });
});
