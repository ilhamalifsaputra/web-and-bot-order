import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import TelegramLoginCard from "./TelegramLoginCard";

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

// Mock the OAuth URL builder
vi.mock("../../lib/telegramOAuth", () => ({
  buildTelegramOAuthUrl: (botId: string, authUrl: string) =>
    `https://oauth.telegram.org/auth?bot_id=${botId}&origin=https%3A%2F%2Fexample.com&return_to=https%3A%2F%2Fexample.com${authUrl}&request_access=write&embed=0`,
}));

describe("TelegramLoginCard", () => {
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
      <TelegramLoginCard botId={undefined} authUrl="/auth/telegram" />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when botId is null", () => {
    const { container } = render(
      <TelegramLoginCard botId={null} authUrl="/auth/telegram" />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when botId is empty string", () => {
    const { container } = render(
      <TelegramLoginCard botId="" authUrl="/auth/telegram" />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders a button with Telegram icon and Continue label when botId is present", () => {
    render(<TelegramLoginCard botId="123456789" authUrl="/auth/telegram" />);

    const button = screen.getByRole("button");
    expect(button).toBeInTheDocument();
    expect(button).toHaveClass("btn", "btn-primary", "w-full");

    const svgIcon = button.querySelector("svg");
    expect(svgIcon).toBeInTheDocument();
    expect(svgIcon).toHaveAttribute("aria-hidden", "true");

    expect(screen.getByText("Continue with Telegram")).toBeInTheDocument();
  });

  it("calls window.location.assign with the OAuth URL when button is clicked", () => {
    render(<TelegramLoginCard botId="123456789" authUrl="/auth/telegram" />);

    const button = screen.getByRole("button");
    fireEvent.click(button);

    expect(assignMock).toHaveBeenCalledWith(
      expect.stringContaining("https://oauth.telegram.org/auth?")
    );
    expect(assignMock).toHaveBeenCalledWith(expect.stringContaining("bot_id=123456789"));
  });

  it("disables the button and shows loading spinner after click", () => {
    render(<TelegramLoginCard botId="123456789" authUrl="/auth/telegram" />);

    const button = screen.getByRole("button");
    fireEvent.click(button);

    expect(button).toBeDisabled();
    expect(screen.getByText("Connecting to Telegram…")).toBeInTheDocument();
  });

  it("includes bot_id, return_to, request_access, and embed in the OAuth URL", () => {
    render(<TelegramLoginCard botId="987654321" authUrl="/account/settings/link-telegram" />);

    const button = screen.getByRole("button");
    fireEvent.click(button);

    const calledUrl = assignMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("bot_id=987654321");
    expect(calledUrl).toContain("return_to=");
    expect(calledUrl).toContain("request_access=write");
    expect(calledUrl).toContain("embed=0");
  });
});
