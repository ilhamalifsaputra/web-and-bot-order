import "@testing-library/jest-dom";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import TelegramLoginButton from "./TelegramLoginButton";
import { buildTelegramOAuthUrl } from "../../lib/telegramOAuth";

// Mock the i18n module
vi.mock("../../lib/i18n", () => ({
  t: (key: string) => {
    const translations: Record<string, string> = {
      "web.login_telegram": "Continue with Telegram",
      "web.tg_connecting": "Connecting to Telegram…",
    };
    return translations[key] || key;
  },
}));

// buildTelegramOAuthUrl is intentionally NOT mocked in this file: the real
// implementation is cheap/pure, and letting the component call it for real
// is what makes the URL-content assertions below an honest integration
// check between the component and the actual builder (see telegramOAuth.test.ts
// for the builder's own isolated unit tests).

describe("TelegramLoginButton", () => {
  let originalLocation: Location;
  let assignMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    originalLocation = window.location;
    assignMock = vi.fn();
    delete (window as any).location;
    (window as any).location = {
      assign: assignMock,
      origin: "https://example.com",
    };
  });

  afterEach(() => {
    (window as any).location = originalLocation;
  });

  it("renders nothing when botId is undefined", () => {
    const { container } = render(
      <TelegramLoginButton botId={undefined} authUrl="/auth/telegram" />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when botId is null", () => {
    const { container } = render(
      <TelegramLoginButton botId={null} authUrl="/auth/telegram" />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when botId is empty string", () => {
    const { container } = render(
      <TelegramLoginButton botId="" authUrl="/auth/telegram" />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders a button with Telegram icon and Continue label when botId is present", () => {
    render(<TelegramLoginButton botId="123456789" authUrl="/auth/telegram" />);

    const button = screen.getByRole("button");
    expect(button).toBeInTheDocument();
    expect(button).toHaveClass("btn", "btn-soft", "w-full");

    const svgIcon = button.querySelector("svg");
    expect(svgIcon).toBeInTheDocument();
    expect(svgIcon).toHaveAttribute("aria-hidden", "true");

    expect(screen.getByText("Continue with Telegram")).toBeInTheDocument();
  });

  it("calls window.location.assign with the OAuth URL when button is clicked", () => {
    render(<TelegramLoginButton botId="123456789" authUrl="/auth/telegram" />);

    const button = screen.getByRole("button");
    fireEvent.click(button);

    const calledUrl = assignMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("https://oauth.telegram.org/auth?");
    expect(calledUrl).toContain("bot_id=123456789");
  });

  it("disables the button and shows loading spinner after click", () => {
    render(<TelegramLoginButton botId="123456789" authUrl="/auth/telegram" />);

    const button = screen.getByRole("button");
    fireEvent.click(button);

    expect(button).toBeDisabled();
    expect(screen.getByText("Connecting to Telegram…")).toBeInTheDocument();
  });

  // This test deliberately does NOT stub buildTelegramOAuthUrl — it asserts
  // on the URL the REAL builder produces for the props this test renders
  // with, so it would fail if the component ever stopped passing bot_id/
  // authUrl through correctly, unlike a mock-returns-mock tautology.
  it("includes bot_id, return_to, request_access, and embed in the real OAuth URL", () => {
    render(<TelegramLoginButton botId="987654321" authUrl="/account/settings/link-telegram" />);

    const button = screen.getByRole("button");
    fireEvent.click(button);

    const calledUrl = assignMock.mock.calls[0][0] as string;
    const expected = buildTelegramOAuthUrl(
      "987654321",
      "/account/settings/link-telegram",
      "https://example.com",
    );
    expect(calledUrl).toBe(expected);
    expect(calledUrl).toMatch(/^https:\/\/oauth\.telegram\.org\/auth\?/);
    expect(calledUrl).toContain("bot_id=987654321");
    expect(calledUrl).toContain("return_to=");
    expect(calledUrl).toContain("request_access=write");
    expect(calledUrl).toContain("embed=0");
  });

  it("runs beforeNavigate first and only then navigates", async () => {
    let release!: () => void;
    const beforeNavigate = vi.fn(() => new Promise<void>((r) => { release = r; }));
    render(<TelegramLoginButton botId="123456789" authUrl="/x" beforeNavigate={beforeNavigate} />);
    fireEvent.click(screen.getByRole("button"));
    expect(beforeNavigate).toHaveBeenCalledTimes(1);
    expect(assignMock).not.toHaveBeenCalled();
    await act(async () => { release(); });
    expect(assignMock).toHaveBeenCalledTimes(1);
  });

  it("does not navigate and re-enables the button when beforeNavigate fails", async () => {
    const beforeNavigate = vi.fn(() => Promise.reject(new Error("nope")));
    render(<TelegramLoginButton botId="123456789" authUrl="/x" beforeNavigate={beforeNavigate} />);
    const button = screen.getByRole("button");
    await act(async () => { fireEvent.click(button); });
    expect(assignMock).not.toHaveBeenCalled();
    expect(button).not.toBeDisabled();
  });

  it("re-enables the button when the page is restored from bfcache (pageshow, persisted)", () => {
    render(<TelegramLoginButton botId="123456789" authUrl="/auth/telegram" />);

    const button = screen.getByRole("button");
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(screen.getByText("Connecting to Telegram…")).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });

    expect(button).not.toBeDisabled();
    expect(screen.getByText("Continue with Telegram")).toBeInTheDocument();
  });

  it("does not re-enable the button on a pageshow that is not from bfcache (persisted: false)", () => {
    render(<TelegramLoginButton botId="123456789" authUrl="/auth/telegram" />);

    const button = screen.getByRole("button");
    fireEvent.click(button);
    expect(button).toBeDisabled();

    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
    });

    expect(button).toBeDisabled();
  });
});
