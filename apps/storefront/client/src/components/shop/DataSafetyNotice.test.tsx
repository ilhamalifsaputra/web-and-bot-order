import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import DataSafetyNotice from "./DataSafetyNotice";
import { t } from "../../lib/i18n";

describe("DataSafetyNotice", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
  });

  it("renders the safety title and body copy", () => {
    render(<DataSafetyNotice />);
    expect(screen.getByText(t("web.support_safety_title"))).toBeInTheDocument();
    expect(screen.getByText(t("web.support_safety_body"))).toBeInTheDocument();
  });

  it("keeps its shield icon out of the accessibility tree", () => {
    const { container } = render(<DataSafetyNotice />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute("aria-hidden", "true");
  });
});
