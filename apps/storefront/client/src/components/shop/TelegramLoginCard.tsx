import { useState } from "react";
import { t } from "../../lib/i18n";
import { buildTelegramOAuthUrl } from "../../lib/telegramOAuth";
import Spinner from "./Spinner";
import TelegramIcon from "./TelegramIcon";

export interface TelegramLoginCardProps {
  /** "" or null/undefined hides the button entirely (no bot configured). */
  botId: string | null | undefined;
  /** Relative path Telegram 303s back to (e.g. widget.auth_url, or the
   *  fixed /account/settings/link-telegram route). */
  authUrl: string;
}

export default function TelegramLoginCard({ botId, authUrl }: TelegramLoginCardProps) {
  const [connecting, setConnecting] = useState(false);
  if (!botId) return null;

  function handleClick() {
    setConnecting(true);
    window.location.assign(buildTelegramOAuthUrl(botId as string, authUrl));
  }

  return (
    <button type="button" className="btn btn-primary w-full" onClick={handleClick} disabled={connecting}>
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
