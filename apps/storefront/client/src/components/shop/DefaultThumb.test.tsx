import "@testing-library/jest-dom";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import DefaultThumb, { type ThumbnailKind } from "./DefaultThumb";

// One icon per kind (Gamepad2/Ticket/KeyRound/Clapperboard/AppWindow/Package)
// — lucide renders an <svg class="lucide lucide-<name>">, so the kind-specific
// class name is what proves the RIGHT icon rendered, not just any icon.
const EXPECTED_ICON_CLASS: Record<ThumbnailKind, string> = {
  game: "lucide-gamepad-2",
  voucher: "lucide-ticket",
  steam: "lucide-key-round",
  entertainment: "lucide-clapperboard",
  app: "lucide-app-window",
  generic: "lucide-package",
};

describe("DefaultThumb", () => {
  it.each(Object.keys(EXPECTED_ICON_CLASS) as ThumbnailKind[])(
    "renders the %s icon inside the tinted well, with no external image request",
    (kind) => {
      const { container } = render(<DefaultThumb kind={kind} name="Some Product" />);
      const icon = container.querySelector(`.${EXPECTED_ICON_CLASS[kind]}`);
      expect(icon).toBeInTheDocument();
      expect(icon).toHaveAttribute("aria-hidden", "true");
      // Zero <img>/<picture> — the whole point is no image request at all.
      expect(container.querySelector("img")).toBeNull();
      expect(container.querySelector("picture")).toBeNull();
    },
  );

  it("shows the product name under the icon when given one", () => {
    render(<DefaultThumb kind="generic" name="Netflix Premium" />);
    expect(screen.getByText("Netflix Premium")).toBeInTheDocument();
  });

  it("omits the name label entirely when none is given", () => {
    const { container } = render(<DefaultThumb kind="generic" />);
    expect(container.querySelector("span")).toBeNull();
  });

  it("falls back to the generic Package icon for an unrecognized kind", () => {
    // Defensive: a payload from an older server build, or a value not yet in
    // the ICONS map, must still render something rather than crash.
    const { container } = render(
      <DefaultThumb kind={"not-a-real-kind" as ThumbnailKind} name="X" />,
    );
    expect(container.querySelector(".lucide-package")).toBeInTheDocument();
  });

  it("fills its parent (h-full w-full) and merges in a caller-provided className", () => {
    const { container } = render(<DefaultThumb kind="voucher" className="rounded-xl" />);
    const well = container.firstElementChild;
    expect(well).toHaveClass("h-full", "w-full", "rounded-xl");
  });
});
