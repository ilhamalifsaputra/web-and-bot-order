import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings as SettingsIcon, CreditCard, KeyRound } from "lucide-react";
import { SettingsNav } from "./SettingsNav";
import { computeNavScrollLeft } from "./settingsNavScroll";

// This project's jsdom test environment doesn't provide `window.localStorage`
// (confirmed: SettingsNav's own defensive try/catch around it exists for
// exactly this reason) — stub a minimal in-memory implementation so these
// persistence tests can exercise the real read/write calls.
function installFakeLocalStorage() {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
      clear: () => { store.clear(); },
    },
  });
}

beforeEach(() => {
  installFakeLocalStorage();
});

const TOP = [{ id: "settings-general", label: "General", icon: SettingsIcon, visible: true }];
const BOTTOM = [{ id: "settings-security", label: "Security", icon: KeyRound, visible: true }];
const GROUP = {
  label: "Payment Gateways",
  icon: CreditCard,
  links: [
    { id: "settings-pay-tokopay", label: "TokoPay", icon: CreditCard, visible: true },
    { id: "settings-pay-bybit", label: "Bybit", icon: CreditCard, visible: true },
  ],
};

describe("SettingsNav", () => {
  it("renders top, group, and bottom links", () => {
    render(<SettingsNav topLinks={TOP} group={GROUP} bottomLinks={BOTTOM} />);
    const nav = screen.getByRole("navigation", { name: /settings sections/i });
    expect(within(nav).getByRole("link", { name: "General" })).toHaveAttribute("href", "#settings-general");
    expect(within(nav).getByRole("link", { name: "TokoPay" })).toHaveAttribute("href", "#settings-pay-tokopay");
    expect(within(nav).getByRole("link", { name: "Security" })).toHaveAttribute("href", "#settings-security");
  });

  it("hides a link with visible:false", () => {
    render(
      <SettingsNav
        topLinks={[{ id: "settings-general", label: "General", icon: SettingsIcon, visible: false }]}
        group={null}
        bottomLinks={BOTTOM}
      />,
    );
    expect(screen.queryByRole("link", { name: "General" })).not.toBeInTheDocument();
  });

  it("defaults the Payment Gateways group to expanded", () => {
    render(<SettingsNav topLinks={TOP} group={GROUP} bottomLinks={BOTTOM} />);
    const toggle = screen.getByRole("button", { name: /payment gateways/i });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("collapsing the group persists to localStorage and is restored on next mount", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<SettingsNav topLinks={TOP} group={GROUP} bottomLinks={BOTTOM} />);
    await user.click(screen.getByRole("button", { name: /payment gateways/i }));
    expect(window.localStorage.getItem("settings-nav-pay-expanded")).toBe("false");
    unmount();

    render(<SettingsNav topLinks={TOP} group={GROUP} bottomLinks={BOTTOM} />);
    expect(screen.getByRole("button", { name: /payment gateways/i })).toHaveAttribute("aria-expanded", "false");
  });
});

describe("computeNavScrollLeft", () => {
  it("returns null when the link is already fully visible", () => {
    const link = { offsetLeft: 50, offsetWidth: 80 };
    const nav = { scrollLeft: 0, clientWidth: 300 };
    expect(computeNavScrollLeft(link, nav)).toBeNull();
  });

  it("scrolls right when the link is clipped on the right edge", () => {
    const link = { offsetLeft: 250, offsetWidth: 80 };
    const nav = { scrollLeft: 0, clientWidth: 300 };
    // link right edge (330) exceeds the visible right edge (300) by 30
    expect(computeNavScrollLeft(link, nav)).toBe(30);
  });

  it("scrolls left when the link is clipped on the left edge", () => {
    const link = { offsetLeft: 20, offsetWidth: 80 };
    const nav = { scrollLeft: 100, clientWidth: 300 };
    // link left edge (20) is left of the visible left edge (scrollLeft 100)
    expect(computeNavScrollLeft(link, nav)).toBe(20);
  });
});

describe("SettingsNav scrollspy (mobile snap-to-top regression)", () => {
  // jsdom has no IntersectionObserver; stub one that lets the test manually
  // fire the same callback the component would receive from a real browser.
  let ioCallback: ((entries: Array<{ isIntersecting: boolean; target: Element; boundingClientRect: { top: number } }>) => void) | null;

  beforeEach(() => {
    ioCallback = null;
    (globalThis as any).IntersectionObserver = class {
      constructor(cb: typeof ioCallback) {
        ioCallback = cb;
      }
      observe() {}
      disconnect() {}
    };
  });

  it("never calls scrollIntoView when the active section changes", () => {
    const scrollIntoViewSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoViewSpy;

    render(<SettingsNav topLinks={TOP} group={GROUP} bottomLinks={BOTTOM} />);

    const target = document.createElement("div");
    target.id = "settings-general";
    act(() => {
      ioCallback?.([{ isIntersecting: true, target, boundingClientRect: { top: 10 } }]);
    });

    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
  });
});
