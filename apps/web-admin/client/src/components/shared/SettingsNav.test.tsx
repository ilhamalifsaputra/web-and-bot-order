import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings as SettingsIcon, CreditCard, KeyRound } from "lucide-react";
import { SettingsNav } from "./SettingsNav";

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
