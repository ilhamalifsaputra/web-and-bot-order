import {
  type LucideIcon
} from "lucide-react";

export interface MenuItem {
  href: string;
  icon: LucideIcon;
  labelKey: string;
  descriptionKey: string;
}

export interface MenuGroup {
  headingKey: string;
  items: MenuItem[];
}

/**
 * What a guest account actually has behind it. A guest checked out without
 * registering: the account is synthetic, has no password, no referral code,
 * no reviews and no support tickets — so every other destination would open a
 * screen that can only be empty or refuse them. Orders are the one real thing
 * there, and the reason they have a session at all.
 */
export const GUEST_HREFS = new Set(["/account/orders"]);

/**
 * Narrow a menu to what a guest can actually use, by destination rather than
 * by position. The first version filtered `MENU_GROUPS[0]`, which was only
 * correct while Orders happened to sit in the first group — reshuffling the
 * menu (an ordinary thing to do to an account page) would have handed guests
 * an empty nav with no way to reach the one screen they have, and nothing
 * would have failed to say so. Groups left with no items are dropped, so a
 * heading never renders over an empty list.
 *
 * Exported for its own test; the page itself only uses `GUEST_MENU_GROUPS`.
 */
export function guestMenuGroups(groups: MenuGroup[]): MenuGroup[] {
  return groups
    .map((group) => ({ ...group, items: group.items.filter((item) => GUEST_HREFS.has(item.href)) }))
    .filter((group) => group.items.length > 0);
}
