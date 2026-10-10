/**
 * /contact — the shop's legal identity and customer-service channels, shown
 * for payment-gateway / card-scheme review. Every value comes from
 * `ShopContext` (owner-set in the admin Branding page); nothing is hard-coded
 * and each row renders only when its value is present. With nothing set, only
 * the intro and the help card remain — never an empty card.
 *
 * The crawler shell for this path (apps/storefront/src/routes/spaShell.ts)
 * renders the SAME title, intro and rows from the same settings; keep the two
 * in step or it becomes cloaking.
 */
import { Link } from "react-router-dom";
import { Clock, LifeBuoy, Mail, MapPin, Phone, Store } from "lucide-react";
import type { ReactNode } from "react";
import { useShopContext } from "../components/Layout";
import Card from "../components/ui/Card";
import TelegramIcon from "../components/shop/TelegramIcon";
import WhatsAppIcon from "../components/shop/WhatsAppIcon";
import { t } from "../lib/i18n";
import { isPlainEmail, telHref } from "../lib/telHref";

function Row({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 shrink-0 text-pine">{icon}</span>
      <div className="min-w-0">
        <dt className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{label}</dt>
        <dd className="mt-0.5 whitespace-pre-line break-words text-base text-ink">{children}</dd>
      </div>
    </div>
  );
}

export default function ContactPage() {
  const { data: ctx } = useShopContext();
  const legalName = ctx?.business?.legal_name ?? "";
  const address = ctx?.business?.address ?? "";
  const phone = ctx?.business?.phone ?? "";
  const email = ctx?.business?.email ?? "";
  const hours = ctx?.business?.hours ?? "";
  const waNumber = ctx?.wa_number ?? "";
  const telegramUrl = ctx?.support_telegram_url ?? "";
  const phoneHref = phone ? telHref(phone) : null;
  const hasRows = Boolean(legalName || address || phone || email || hours);
  const hasChannels = Boolean(waNumber || telegramUrl);

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="font-display text-3xl font-semibold text-ink sm:text-4xl">
        {t("web.contact_page_title")}
      </h1>
      <p className="mt-4 text-lg leading-relaxed text-ink-soft">{t("web.contact_intro")}</p>

      {(hasRows || hasChannels) && (
        <Card className="mt-8">
          {hasRows && (
            <dl className="space-y-4">
              {legalName && (
                <Row icon={<Store className="h-5 w-5" aria-hidden="true" />} label={t("web.contact_legal_name")}>
                  {legalName}
                </Row>
              )}
              {address && (
                <Row icon={<MapPin className="h-5 w-5" aria-hidden="true" />} label={t("web.contact_address")}>
                  {address}
                </Row>
              )}
              {phone && (
                <Row icon={<Phone className="h-5 w-5" aria-hidden="true" />} label={t("web.contact_phone")}>
                  {phoneHref ? (
                    <a href={phoneHref} className="text-pine hover:underline">
                      {phone}
                    </a>
                  ) : (
                    phone
                  )}
                </Row>
              )}
              {email && (
                <Row icon={<Mail className="h-5 w-5" aria-hidden="true" />} label={t("web.contact_email")}>
                  {isPlainEmail(email) ? (
                    <a href={`mailto:${email}`} className="text-pine hover:underline">
                      {email}
                    </a>
                  ) : (
                    email
                  )}
                </Row>
              )}
              {hours && (
                <Row icon={<Clock className="h-5 w-5" aria-hidden="true" />} label={t("web.contact_hours_label")}>
                  {hours}
                </Row>
              )}
            </dl>
          )}
          {hasChannels && (
            <div className={`flex flex-wrap gap-2 ${hasRows ? "mt-6 border-t border-line pt-6" : ""}`}>
              {waNumber && (
                <a
                  href={`https://wa.me/${waNumber}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-soft"
                >
                  <WhatsAppIcon className="h-4 w-4" /> WhatsApp
                </a>
              )}
              {telegramUrl && (
                <a
                  href={telegramUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-soft"
                >
                  <TelegramIcon className="h-4 w-4" /> Telegram
                </a>
              )}
            </div>
          )}
        </Card>
      )}

      <Card className="mt-8">
        <h2 className="font-display text-lg font-semibold text-ink">{t("web.static_help_title")}</h2>
        <p className="mt-1 text-sm leading-relaxed text-ink-soft">{t("web.static_help_body")}</p>
        <Link to="/help" className="btn btn-primary mt-4">
          <LifeBuoy className="h-4 w-4" />
          {t("web.static_help_cta")}
        </Link>
      </Card>
    </div>
  );
}
