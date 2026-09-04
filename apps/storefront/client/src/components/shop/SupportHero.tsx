/**
 * Hero for the /help Help & Support page: the "Help & Support" heading, a
 * one-line subtitle, and a decorative support-agent illustration beside it.
 *
 * Static content only — every string comes from `t()`, there is no data here.
 * Page assembly (width, padding, the ticket form below) belongs to HelpPage;
 * this block just needs to look right when a wide container is handed to it.
 *
 * The illustration is purely decorative: `alt=""` + `aria-hidden` keep it out
 * of the accessibility tree, and it renders after the heading in DOM order so
 * a screen reader or a top-to-bottom scan hits the <h1> first. Its width is
 * capped so it stays visually subordinate to the heading.
 */
import { t } from "../../lib/i18n";
import supportHeroUrl from "../../assets/support-hero.svg";

export default function SupportHero() {
  return (
    <header className="flex flex-col gap-8 py-8 md:flex-row md:items-center md:justify-between md:gap-12">
      <div className="max-w-xl">
        <h1 className="font-display text-3xl font-bold text-ink md:text-4xl">{t("web.help_title")}</h1>
        <p className="mt-3 text-base leading-relaxed text-ink-soft md:text-lg">{t("web.help_subtitle")}</p>
      </div>
      <img
        src={supportHeroUrl}
        alt=""
        aria-hidden="true"
        className="w-52 shrink-0 self-center md:w-72 md:self-auto"
      />
    </header>
  );
}
