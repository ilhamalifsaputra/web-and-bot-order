/**
 * One product group on the home page (`#g-<slug>`). Layout `single` (Top Up
 * Games) is one grid; layout `byCategory` (Premium Apps) with several
 * sub-sections opens with a row of category chips — plain jump links in the
 * group nav's pill look, not a second sticky bar — then one sub-section per
 * category plus the merged "More <group>" bucket. The server decides the
 * sections (apps/storefront/src/homeSections.ts); this only renders them, so a
 * new group needs no change here.
 */
import type { HomeGroup, HomeSection } from "../../api/types";
import { t } from "../../lib/i18n";
import HomeShelf from "./HomeShelf";
import {
  HIDDEN_SCROLLBAR_ROW,
  SECTION_TITLE_CLASS,
  groupAnchor,
  jumpPillClass,
  scrollMarginClass,
  sectionAnchor,
} from "./homeLayout";

export interface HomeGroupSectionProps {
  group: HomeGroup;
  hasGroupNav: boolean;
  rankingVersion: number;
  fx: string | null | undefined;
  lowThreshold: number;
}

function sectionTitle(section: HomeSection, groupLabel: string): string {
  if (section.kind === "others") return t("web.home_others_section", { group: groupLabel });
  return section.emoji ? `${section.emoji} ${section.title ?? ""}` : (section.title ?? groupLabel);
}

export default function HomeGroupSection({ group, hasGroupNav, rankingVersion, fx, lowThreshold }: HomeGroupSectionProps) {
  const label = t(group.label_key);
  const heading = `${group.emoji} ${label}`;
  const scrollMargin = scrollMarginClass(hasGroupNav);
  const split = group.layout === "byCategory" && group.sections.length > 1;
  const shelf = (section: HomeSection) => (
    <HomeShelf group={group} section={section} rankingVersion={rankingVersion} fx={fx} lowThreshold={lowThreshold} />
  );

  return (
    <section id={groupAnchor(group.slug)} className={`mt-12 ${scrollMargin}`}>
      <h2 className={SECTION_TITLE_CLASS}>{heading}</h2>
      {split ? (
        <>
          {/* Named by the plain group name: an emoji in an accessible name is
              read out ("gem stone Premium Apps"). */}
          <nav aria-label={label} className="mt-4">
            <div className={`-mx-1 px-1 ${HIDDEN_SCROLLBAR_ROW}`}>
              {group.sections.map((s) => (
                <a key={s.key} href={`#${sectionAnchor(group.slug, s.key)}`} className={jumpPillClass(false)}>
                  {sectionTitle(s, label)}
                </a>
              ))}
            </div>
          </nav>
          {group.sections.map((s) => (
            <section key={s.key} id={sectionAnchor(group.slug, s.key)} className={`mt-8 ${scrollMargin}`}>
              <h3 className="mb-4 text-lg font-semibold text-ink">{sectionTitle(s, label)}</h3>
              {shelf(s)}
            </section>
          ))}
        </>
      ) : (
        group.sections[0] && <div className="mt-5">{shelf(group.sections[0])}</div>
      )}
    </section>
  );
}
