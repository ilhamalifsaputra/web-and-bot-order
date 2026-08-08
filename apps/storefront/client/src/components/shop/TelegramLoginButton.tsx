import { useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import { buildTelegramOAuthUrl } from "../../lib/telegramOAuth";
import Spinner from "./Spinner";
import TelegramIcon from "./TelegramIcon";

export interface TelegramLoginButtonProps {
  /** "" or null/undefined hides the button entirely (no bot configured). */
  botId: string | null | undefined;
  /** Relative path Telegram 303s back to (e.g. widget.auth_url, or the
   *  fixed /account/settings/link-telegram route). */
  authUrl: string;
}

export default function TelegramLoginButton({ botId, authUrl }: TelegramLoginButtonProps) {
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
    window.location.assign(buildTelegramOAuthUrl(resolvedBotId, authUrl));
  }

  return (
    <button type="button" className="btn btn-soft w-full" onClick={handleClick} disabled={connecting}>
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
    </button>
  );
}
