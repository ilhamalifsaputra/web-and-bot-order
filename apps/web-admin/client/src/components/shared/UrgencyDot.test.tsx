import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { UrgencyDot } from "./UrgencyDot";

describe("UrgencyDot", () => {
  it("uses the critical color for level=critical", () => {
    const { container } = render(<UrgencyDot level="critical" />);
    expect(container.querySelector(".bg-rust")).not.toBeNull();
  });

  it("uses the idle color for level=idle", () => {
    const { container } = render(<UrgencyDot level="idle" />);
    expect(container.querySelector(".bg-ink-faint")).not.toBeNull();
  });
});
