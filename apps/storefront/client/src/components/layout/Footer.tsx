/**
 * Site footer — sand background, 1px line top border, brand + tagline, a
 * "Quick Links" nav block and a "Contact" block, centred copyright bar.
 * Extracted from the old single-file Layout.tsx (Task 5 chrome split).
 *
 * Structure/content authority: business-adaptation.md → Navigation → "Footer
 * navigation". Visual treatment: components.md "Footer" (sand bg, mobile
 * accordion). On < sm the two link blocks collapse behind a disclosure
 * button; from sm up they render as static columns.
 */
import { useId, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, Clock, Mail, Phone, Store } from "lucide-react";
import type { ShopContext } from "../../api/types";
import { t } from "../../lib/i18n";
import { telHref } from "../../lib/telHref";
import PaymentMarks from "../shop/PaymentMarks";
import TelegramIcon from "../shop/TelegramIcon";
import WhatsAppIcon from "../shop/WhatsAppIcon";

/** Footer link row — keep in step with App.tsx's routes and with STATIC_PAGES
 * in apps/storefront/src/routes/spaShell.ts. One row here is a utility
 * destination rather than a policy page (/track). */
export const FOOTER_LINKS = [
  // The browse-all shelves are otherwise only linked from the mobile nav
  // drawer / bottom tab bar — this row is how a desktop visitor (and a
  // crawler) reaches them.
  { to: "/products", key: "web.products_title" },
  { to: "/categories", key: "web.categories_page_title" },
  { to: "/track", key: "web.track_title" },
  { to: "/help", key: "web.help_title" },
  { to: "/about", key: "web.about_title" },
  { to: "/contact", key: "web.contact_page_title" },
  { to: "/how-to-order", key: "web.hto_title" },
  { to: "/terms", key: "web.terms_title" },
  { to: "/privacy", key: "web.privacy_title" },
  { to: "/refund", key: "web.refund_title" },
];

/**
 * One footer block. Its heading is a disclosure button on mobile (collapsed by
 * default) and an inert heading from sm up, where the body is always shown.
 * Not the Task 6 Accordion primitive — lightweight inline markup, matching how
 * HomePage's FAQ hand-rolls its own <details> styling.
 */
function FooterBlock({ heading, children }: { heading: string; children: ReactNode }) {
  const bodyId = useId();
  const [open, setOpen] = useState(false);
  return (
    <>
      <h3 className="font-display text-base font-semibold text-ink">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={bodyId}
          className="flex w-full items-center justify-between py-2 text-left sm:pointer-events-none sm:py-0"
        >
          {heading}
          <ChevronDown
            aria-hidden="true"
            className={`h-4 w-4 shrink-0 text-ink-faint transition-transform sm:hidden ${open ? "rotate-180" : ""}`}
          />
        </button>
      </h3>
      <div id={bodyId} className={`${open ? "block" : "hidden"} sm:block`}>
        {children}
      </div>
    </>
  );
}

export default function Footer({
  ctx,
  clearBottomNav = false,
}: {
  ctx: ShopContext | undefined;
  /** Add bottom padding equal to the mobile tab bar's height + safe-area so
   *  the copyright line is never hidden behind it. Mirrors the bar's own
   *  visible/hidden logic (Layout owns that decision). */
  clearBottomNav?: boolean;
}) {
  const shopName = ctx?.shop_name ?? "";
  const shopTagline = ctx?.shop_tagline ?? "";
  const waNumber = ctx?.wa_number ?? "";
  const botUsername = ctx?.bot_username ?? "";
  const legalName = ctx?.business?.legal_name ?? "";
  const address = ctx?.business?.address ?? "";
  const phone = ctx?.business?.phone ?? "";
  const phoneHref = phone ? telHref(phone) : null;
  const email = ctx?.business?.email ?? "";
  const hours = ctx?.business?.hours ?? "";
  const payMethods = ctx?.pay_methods;
  const showPayMarks = Boolean(payMethods && (payMethods.qris || payMethods.card));
  const hasContactList = Boolean(waNumber || botUsername || phone || email || hours);

  return (
    <footer
      className={`mt-16 border-t border-line bg-sand ${
        clearBottomNav
          ? "pb-[calc(var(--spacing-bottom-nav)_+_env(safe-area-inset-bottom))] sm:pb-0"
          : ""
      }`}
    >
      <div className="mx-auto max-w-6xl px-4 py-10 lg:px-6">
        <div className="grid gap-4 sm:gap-8 md:grid-cols-4">
          {/* Columns 1-2: brand identity + tagline + the legal operator and
              address (owner-set in Branding; each shown only when filled). No
              social icons — this shop has no social-links Setting for them. */}
          <div className="md:col-span-2">
            <span className="flex items-center gap-2 font-display font-semibold text-pine">
              <Store className="h-5 w-5" /> {shopName}
            </span>
            {shopTagline && <p className="mt-3 max-w-sm text-sm text-ink-soft">{shopTagline}</p>}
            {legalName && (
              <p className="mt-3 text-sm font-medium text-ink">
                {t("web.footer_operated_by", { name: legalName })}
              </p>
            )}
            {address && (
              <p className="mt-1 max-w-sm whitespace-pre-line text-sm text-ink-soft">{address}</p>
            )}
          </div>

          {/* Column 3: informational pages. The only internal link that lets a
              crawler reach the policy pages, so this stays the primary footer
              nav landmark. */}
          <nav
            aria-label={t("web.nav_footer")}
            className="border-t border-line py-1 sm:border-0 sm:py-0"
          >
            <FooterBlock heading={t("web.footer_links_heading")}>
              <ul className="mt-3 flex flex-col gap-2 text-sm">
                {FOOTER_LINKS.map(({ to, key }) => (
                  <li key={to}>
                    <Link to={to} className="text-ink-soft transition-colors hover:text-pine">
                      {t(key)}
                    </Link>
                  </li>
                ))}
              </ul>
            </FooterBlock>
          </nav>

          {/* Column 4: direct contact. Each link is independently conditional on
              the shop having set that channel up. */}
          <div className="border-t border-line py-1 sm:border-0 sm:py-0">
            <FooterBlock heading={t("web.footer_contact_heading")}>
              {hasContactList && (
                <ul className="mt-3 flex flex-col gap-2 text-sm">
                  {waNumber && (
                    <li>
                      <a
                        href={`https://wa.me/${waNumber}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 text-ink-soft transition-colors hover:text-pine"
                      >
                        <WhatsAppIcon className="h-4 w-4" /> WhatsApp
                      </a>
                    </li>
                  )}
                  {botUsername && (
                    <li>
                      <a
                        href={`https://t.me/${botUsername}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 text-ink-soft transition-colors hover:text-pine"
                      >
                        <TelegramIcon className="h-4 w-4" /> Telegram
                      </a>
                    </li>
                  )}
                  {phone && (
                    <li>
                      {phoneHref ? (
                        <a
                          href={phoneHref}
                          className="flex items-center gap-2 text-ink-soft transition-colors hover:text-pine"
                        >
                          <Phone className="h-4 w-4" aria-hidden="true" /> {phone}
                        </a>
                      ) : (
                        <span className="flex items-center gap-2 text-ink-soft">
                          <Phone className="h-4 w-4" aria-hidden="true" /> {phone}
                        </span>
                      )}
                    </li>
                  )}
                  {email && (
                    <li>
                      <a
                        href={`mailto:${email}`}
                        className="flex items-center gap-2 break-all text-ink-soft transition-colors hover:text-pine"
                      >
                        <Mail className="h-4 w-4 shrink-0" aria-hidden="true" /> {email}
                      </a>
                    </li>
                  )}
                  {hours && (
                    <li className="flex items-start gap-2 text-ink-soft">
                      <Clock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                      <span className="whitespace-pre-line">{hours}</span>
                    </li>
                  )}
                </ul>
              )}
            </FooterBlock>
          </div>
        </div>

        {showPayMarks && (
          <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-line pt-6">
            <span className="text-sm font-semibold text-ink">{t("web.footer_payment_methods")}</span>
            <PaymentMarks methods={payMethods} />
          </div>
        )}
      </div>

      {/* Separator + centred copyright bar. */}
      <div className="border-t border-line px-4 py-6 text-center text-xs text-ink-faint sm:text-sm lg:px-6">
        {legalName && (
          <p className="mb-1">
            © {new Date().getFullYear()} {legalName}
          </p>
        )}
        {t("web.footer_note")}
      </div>
    </footer>
  );
}
