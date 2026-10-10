/** Post-purchase "top-up details" for a game order (OrderDetailPage, PayPage).
 * Shows only what exists: product + denomination, the Game/Zone/Server the buyer
 * typed per unit (the server reads them through the denomination's input
 * mapping — never other answers), the full provider SN with a Copy button, and
 * the buyer-safe Digiflazz status line. A missing value omits its line, so the
 * card never prints an empty label. */
import { useState } from "react";
import { BadgeCheck, Copy } from "lucide-react";
import type { GameTarget } from "../../api/types";
import { t } from "../../lib/i18n";
import Button from "../ui/Button";

const TARGET_ROWS: Array<[keyof GameTarget, string]> = [
  ["game_id", "web.topup_game_id"],
  ["zone_id", "web.topup_zone_id"],
  ["server_id", "web.topup_server_id"],
];

export default function GameTopupDetailCard({
  items,
  targets,
  sn,
  digiflazzStatus,
}: {
  items: Array<{ name: string; duration?: string | null }>;
  targets: GameTarget[];
  sn: string | null;
  digiflazzStatus?: "pending" | "reviewing" | null;
}) {
  const [copied, setCopied] = useState(false);
  const units = targets.filter((target) => TARGET_ROWS.some(([key]) => Boolean(target[key])));
  if (items.length === 0 && units.length === 0 && !sn && !digiflazzStatus) return null;

  function copySn(): void {
    void navigator.clipboard.writeText(sn ?? "");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <section className="card card-pad min-w-0 border-grass/40">
      <h2 className="section-title flex items-center gap-2">
        <BadgeCheck aria-hidden="true" className="w-5 h-5 text-grass" /> {t("web.topup_detail_title")}
      </h2>

      {items.length > 0 && (
        <ul className="mt-3 space-y-1">
          {items.map((item, idx) => (
            <li key={idx} className="text-sm">
              <span className="font-semibold break-words">{item.name}</span>
              {item.duration && <span className="ml-2 text-ink-soft break-words">{item.duration}</span>}
            </li>
          ))}
        </ul>
      )}

      {units.length > 0 && (
        <div className="mt-3 space-y-3 text-sm">
          {units.map((target, unitIdx) => (
            <div key={unitIdx}>
              {units.length > 1 && (
                <div className="text-xs font-semibold text-ink-soft mb-1">
                  {t("web.checkout_info_unit", { unit: unitIdx + 1, total: units.length })}
                </div>
              )}
              <dl className="space-y-1">
                {TARGET_ROWS.map(([key, labelKey]) =>
                  target[key] ? (
                    <div key={key} className="grid grid-cols-2 gap-3">
                      <dt className="text-ink-soft break-words">{t(labelKey)}</dt>
                      <dd className="font-medium text-right break-all">{target[key]}</dd>
                    </div>
                  ) : null,
                )}
              </dl>
            </div>
          ))}
        </div>
      )}

      {sn && (
        <div className="mt-3">
          <div className="text-xs font-semibold text-ink-soft mb-1">{t("web.topup_sn")}</div>
          <div className="flex flex-wrap items-center gap-2">
            <code className="codeish min-w-0 flex-1 text-sm! break-all whitespace-pre-wrap select-all">{sn}</code>
            <Button variant="soft" className="min-h-11" onClick={copySn}>
              <Copy className="w-3.5 h-3.5" /> {copied ? t("web.copied") : t("web.copy")}
            </Button>
          </div>
        </div>
      )}

      {digiflazzStatus === "pending" && <p className="mt-3 text-xs text-ink-soft">{t("web.digiflazz_pending_body")}</p>}
      {digiflazzStatus === "reviewing" && <p className="mt-3 text-xs text-ink-soft">{t("web.digiflazz_failed_body")}</p>}
    </section>
  );
}
