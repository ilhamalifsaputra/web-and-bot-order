import { useEffect, useState, type RefObject } from "react";

const WIDGET_TIMEOUT_MS = 4000;

export interface TelegramWidgetOptions {
  botUsername: string | null | undefined;
  authUrl: string;
}

/**
 * Injects the Telegram Login Widget's own `<script>` into `containerRef`
 * (shared by LoginPage and SettingsPage — same embed, different auth-url).
 *
 * STO-013: when the page's origin isn't registered via BotFather's
 * `/setdomain`, Telegram's script renders its own raw error text ("Bot
 * domain invalid") into the container instead of the widget iframe — no
 * error event or callback fires, so a timeout that checks for the iframe
 * Telegram injects on success is the only available signal. Callers should
 * hide the container (it may hold Telegram's unstyled error text) and show
 * their own fallback copy when this returns `true`.
 */
export function useTelegramWidget(
  containerRef: RefObject<HTMLDivElement | null>,
  { botUsername, authUrl }: TelegramWidgetOptions,
): boolean {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !botUsername) return;
    setFailed(false);
    const script = document.createElement("script");
    script.async = true;
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.setAttribute("data-telegram-login", botUsername);
    script.setAttribute("data-size", "large");
    script.setAttribute("data-userpic", "false");
    script.setAttribute("data-radius", "12");
    script.setAttribute("data-auth-url", authUrl);
    script.setAttribute("data-request-access", "write");
    container.appendChild(script);

    const timer = window.setTimeout(() => {
      if (!container.querySelector("iframe")) setFailed(true);
    }, WIDGET_TIMEOUT_MS);

    return () => {
      window.clearTimeout(timer);
      container.removeChild(script);
    };
  }, [containerRef, botUsername, authUrl]);

  return failed;
}
