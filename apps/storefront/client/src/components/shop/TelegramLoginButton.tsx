/**
 * Task 15: the button element itself is now `<Button variant="soft"
 * fullWidth>` (`components/ui/Button.tsx`) instead of a hand-rolled
 * `<button className="btn btn-soft w-full">` — Button composes those exact
 * three classes (`cn("btn", "btn-soft", fullWidth && "w-full")`), so the
 * rendered class list, and every existing test assertion against it, is
 * unchanged. `disabled`/`onClick`/children content and the bfcache
 * `pageshow` reset are all untouched — this is a container swap only.
 */
import { useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import { buildTelegramOAuthUrl } from "../../lib/telegramOAuth";
import Button from "../ui/Button";
import Spinner from "./Spinner";
import TelegramIcon from "./TelegramIcon";

export interface TelegramLoginButtonProps {
  /** "" or null/undefined hides the button entirely (no bot configured). */
  botId: string | null | undefined;
  /** Relative path Telegram 303s back to (e.g. widget.auth_url, or the
   *  fixed /account/settings/link-telegram route). */
  authUrl: string;
  /** Awaited before leaving for Telegram (SettingsPage arms the one-time link
   *  intent here). If it rejects, the button re-enables and stays put. */
  beforeNavigate?: () => Promise<unknown>;
}

export default function TelegramLoginButton({ botId, authUrl, beforeNavigate }: TelegramLoginButtonProps) {
  const [connecting, setConnecting] = useState(false);

  // Clicking navigates away to oauth.telegram.org, so `connecting` is set
  // and never explicitly cleared on this page. If the user hits Back, some
  // browsers (bfcache) restore this page with React state intact instead of
  // remounting it — without this, the button would stay stuck disabled
  // showing "Connecting..." forever with no way to recover short of a
  // manual reload. `pageshow` with `persisted: true` fires exactly on that
  // bfcache restore, so resetting state there fixes it.
  useEffect(() => {
    function onPageShow(e: PageTransitionEvent) {
      if (e.persisted) setConnecting(false);
    }
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  if (!botId) return null;
  const resolvedBotId = botId;

  function handleClick() {
    setConnecting(true);
    if (!beforeNavigate) {
      window.location.assign(buildTelegramOAuthUrl(resolvedBotId, authUrl));
      return;
    }
    beforeNavigate().then(
      () => window.location.assign(buildTelegramOAuthUrl(resolvedBotId, authUrl)),
      () => setConnecting(false),
    );
  }

  return (
    <Button variant="soft" fullWidth onClick={handleClick} disabled={connecting}>
      {connecting ? (
        <>
          <Spinner />
          {t("web.tg_connecting")}
        </>
      ) : (
        <>
          <TelegramIcon />
          {t("web.login_telegram")}
        </>
      )}
    </Button>
  );
}
