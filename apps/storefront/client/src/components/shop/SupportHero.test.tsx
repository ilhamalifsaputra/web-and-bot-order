import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import SupportHero from "./SupportHero";
import { t } from "../../lib/i18n";

describe("SupportHero", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
  });

  it("renders the page title as the h1 heading", () => {
    render(<SupportHero />);
    const heading = screen.getByRole("heading", { level: 1, name: t("web.help_title") });
    expect(heading).toBeInTheDocument();
    expect(heading.tagName).toBe("H1");
  });

  it("renders the subtitle text", () => {
    render(<SupportHero />);
    expect(screen.getByText(t("web.help_subtitle"))).toBeInTheDocument();
  });

  it("keeps the decorative illustration out of the accessibility tree", () => {
    const { container } = render(<SupportHero />);
    // Empty alt + aria-hidden => not exposed as an image to assistive tech.
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("alt", "");
    expect(img).toHaveAttribute("aria-hidden", "true");
    expect(img).toHaveAttribute("src");
  });

  it("orders the heading before the illustration in the DOM", () => {
    const { container } = render(<SupportHero />);
    const heading = screen.getByRole("heading", { level: 1 });
    const img = container.querySelector("img")!;
    // Node.DOCUMENT_POSITION_FOLLOWING (4) => img comes after the heading.
    expect(heading.compareDocumentPosition(img) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
