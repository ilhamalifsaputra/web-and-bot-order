import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, onTestFinished, vi, type Mock } from "vitest";
import { render, screen, waitFor, act, within, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import HomePage from "./HomePage";
import { apiGet } from "../api/client";
import type { GroupPageData, HomeGroup, HomePageData, HomeSection, ShopContext } from "../api/types";
import type { ProductCardData } from "../components/shop/ProductCard";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
}));

const context: ShopContext = {
  lang: "en",
  fx: "16000",
  shop_name: "Toko Digital",
  shop_tagline: "",
  cart_count: 0,
  customer: null,
  favicon_url: "/static/favicon.svg",
  logo_url: "",
  bot_username: "tokobot",
  support_telegram_url: "https://t.me/shopsupport",
  wa_number: null,
  tzname: "Asia/Jakarta",
  currency: null,
};

const product: ProductCardData = {
  slug: "netflix-premium",
  name: "Netflix Premium",
  category_name: "Streaming",
  from_price: "79000",
  variant_count: 1,
  image: "",
  available: 10,
  rating: 4.6,
  rating_count: 12,
  bulk_discount: null,
  bulk_min_qty: null,
  all_non_auto: false,
};

function card(slug: string, name: string, extra: Partial<ProductCardData> = {}): ProductCardData {
  return { ...product, slug, name, ...extra };
}

function cards(prefix: string, from: number, count: number, extra: Partial<ProductCardData> = {}): ProductCardData[] {
  return Array.from({ length: count }, (_, i) => card(`${prefix}-${from + i}`, `${prefix} ${from + i}`, extra));
}

function section(overrides: Partial<HomeSection> & Pick<HomeSection, "key">): HomeSection {
  const products = overrides.products ?? [product];
  return {
    kind: "group",
    title: null,
    emoji: null,
    category_slugs: ["streaming"],
    total: products.length,
    all_sold_out: false,
    ...overrides,
    products,
  };
}

function premiumGroup(overrides: Partial<HomeGroup> = {}): HomeGroup {
  return {
    key: "PREMIUM_APPS",
    slug: "premium-apps",
    label_key: "web.group_premium_apps",
    emoji: "💎",
    layout: "byCategory",
    category_count: 1,
    single_category_slug: "streaming",
    sections: [section({ key: "all" })],
    ...overrides,
  };
}

const gameCard = (slug: string, name: string) =>
  card(slug, name, { category_name: "Mobile Legends", variant_count: 12, all_non_auto: true, available: 0, rating: null, rating_count: 0 });

function gameGroup(overrides: Partial<HomeGroup> = {}): HomeGroup {
  return {
    key: "GAME_TOPUP",
    slug: "top-up-games",
    label_key: "web.group_game_topup",
    emoji: "🎮",
    layout: "single",
    category_count: 2,
    single_category_slug: null,
    sections: [
      section({
        key: "all",
        category_slugs: ["mobile-legends", "free-fire"],
        products: [gameCard("ml-diamonds", "Mobile Legends Diamonds"), gameCard("ff-diamonds", "Free Fire Diamonds")],
      }),
    ],
    ...overrides,
  };
}

/** Premium Apps split by category: two big categories plus an "others" bucket. */
function premiumByCategory(): HomeGroup {
  return premiumGroup({
    category_count: 3,
    single_category_slug: null,
    sections: [
      section({ key: "c-streaming", kind: "category", title: "Streaming", emoji: "🎬", category_slugs: ["streaming"], products: cards("Stream", 1, 3) }),
      section({ key: "c-music", kind: "category", title: "Music", emoji: "🎵", category_slugs: ["music"], products: cards("Tune", 1, 3) }),
      section({ key: "others", kind: "others", category_slugs: ["tools", "vpn"], products: cards("Tool", 1, 2) }),
    ],
  });
}

type HomeOverrides = Partial<HomePageData> & {
  /** Shorthand: the cards of the default single Premium Apps section (and the
   * hero preview when there are at least two). */
  products?: ProductCardData[];
};

function homeFixture({ products, ...overrides }: HomeOverrides = {}): HomePageData {
  const sectionCards = products ?? [product];
  return {
    hero_image: null,
    hero_products: sectionCards.length >= 2 ? sectionCards.slice(0, 3) : [],
    groups: [premiumGroup({ sections: [section({ key: "all", products: sectionCards })] })],
    flash: [],
    ranking_version: 7,
    testimonials: [],
    low_threshold: 5,
    bot_username: "tokobot",
    support_telegram_url: "https://t.me/shopsupport",
    wa_number: "6281234567890",
    ...overrides,
  };
}

function renderHome(data: HomePageData, respondGroup?: (path: string) => unknown) {
  // `home.current` lets a test change what the next home refetch returns.
  const home = { current: data };
  (apiGet as Mock).mockImplementation(async (path: string) => {
    if (path === "/api/v1/pages/context") return context;
    if (path === "/api/v1/pages/home") return home.current;
    if (respondGroup && path.startsWith("/api/v1/pages/group/")) return respondGroup(path);
    throw new Error(`unexpected path ${path}`);
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, queryClient, home };
}

/** A group-endpoint page as the home "Show more" receives it. */
function groupPage(products: ProductCardData[], next_offset: number | null, total: number): GroupPageData {
  return {
    group: { key: "PREMIUM_APPS", slug: "premium-apps", label_key: "web.group_premium_apps", emoji: "💎", allow_cheapest: true },
    unavailable: false,
    categories: [],
    sort: "bestseller",
    products,
    total,
    next_offset,
    ranking_version: 7,
    low_threshold: 5,
  };
}

/** Answers "Show more" from a ranked list of `total` cards, paging by offset/limit. */
function pagedResponder(prefix: string, total: number) {
  return (path: string) => {
    const url = new URL(path, "http://shop.test");
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    const end = Math.min(total, offset + limit);
    return groupPage(cards(prefix, offset + 1, end - offset), end < total ? end : null, total);
  };
}

const groupCalls = () =>
  (apiGet as Mock).mock.calls.map((c) => c[0] as string).filter((p) => p.startsWith("/api/v1/pages/group/"));

/** IntersectionObserver stand-in that lets a test say which sections are on screen. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly observed: Element[] = [];
  constructor(readonly callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
  show(visibleIds: string[]) {
    const entries = this.observed.map((target) => ({ target, isIntersecting: visibleIds.includes(target.id) }) as IntersectionObserverEntry);
    this.callback(entries, this as unknown as IntersectionObserver);
  }
}

const twoGroups = () => homeFixture({ groups: [premiumGroup(), gameGroup()] });

describe("HomePage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    FakeIntersectionObserver.instances = [];
  });

  it("renders the hero and the group's product cards", async () => {
    renderHome(homeFixture());
    expect(await screen.findByText("Your digital needs, one trusted place.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Netflix Premium" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "💎 Premium Apps" })).toBeInTheDocument();
  });

  it("gives the contact cards a consistent lift-and-shadow hover treatment", async () => {
    renderHome(homeFixture());
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const ticketLink = screen.getByRole("link", { name: /Support ticket/ });
    expect(ticketLink.className).toContain("hover:-translate-y-0.5");
    expect(ticketLink.className).toContain("hover:shadow-lift");
  });

  it("removes the category tiles and the old new-arrivals shelf", async () => {
    const { container } = renderHome(twoGroups());
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(container.querySelector("#categories")).toBeNull();
    expect(container.querySelector("#products")).toBeNull();
    expect(screen.queryByRole("link", { name: /View products/ })).not.toBeInTheDocument();
    expect(screen.queryByText("New arrivals")).not.toBeInTheDocument();
  });

  describe("group nav", () => {
    it("shows one jump pill per group, in the payload's order, under the navbar", async () => {
      renderHome(twoGroups());
      const nav = await screen.findByRole("navigation", { name: "Product types" });
      const pills = within(nav).getAllByRole("link");
      expect(pills.map((a) => a.textContent)).toEqual(["💎 Premium Apps", "🎮 Top Up Games"]);
      expect(pills.map((a) => a.getAttribute("href"))).toEqual(["#g-premium-apps", "#g-top-up-games"]);
      expect(nav.closest(".sticky")?.className).toContain("top-16");
      // Each section clears the navbar plus the pill bar when jumped to.
      expect(document.getElementById("g-premium-apps")?.className).toContain("scroll-mt-32");
    });

    // A native #hash jump would leave `/#g-…` in history, and Back from a
    // product page would then land on the anchor instead of where the
    // visitor was. Pills, chips and hero CTAs scroll in place instead.
    it("jumps to a section on pill, chip and hero CTA clicks without a #hash history entry", async () => {
      const scrollIntoView = vi.fn();
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = scrollIntoView;
      onTestFinished(() => {
        Element.prototype.scrollIntoView = original;
      });
      renderHome(homeFixture({ groups: [premiumByCategory(), gameGroup()] }));
      const nav = await screen.findByRole("navigation", { name: "Product types" });
      const targets = () => scrollIntoView.mock.contexts.map((el) => (el as Element).id);

      const pill = within(nav).getByRole("link", { name: "🎮 Top Up Games" });
      expect(pill).toHaveAttribute("href", "#g-top-up-games");
      expect(fireEvent.click(pill)).toBe(false);
      const chip = within(screen.getByRole("navigation", { name: "Premium Apps" })).getByRole("link", { name: "🎵 Music" });
      expect(fireEvent.click(chip)).toBe(false);
      expect(fireEvent.click(screen.getByRole("link", { name: "Browse products" }))).toBe(false);
      expect(fireEvent.click(screen.getByRole("link", { name: "Shop by type" }))).toBe(false);

      expect(targets()).toEqual(["g-top-up-games", "g-premium-apps-c-music", "g-premium-apps", "home-group-nav"]);
      expect(window.location.hash).toBe("");
    });

    it("is not rendered with a single group", async () => {
      renderHome(homeFixture());
      await screen.findByRole("heading", { name: "Netflix Premium" });
      expect(screen.queryByRole("navigation", { name: "Product types" })).not.toBeInTheDocument();
      expect(document.getElementById("g-premium-apps")?.className).toContain("scroll-mt-20");
    });

    it("marks the group on screen as current (scrollspy)", async () => {
      vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
      renderHome(twoGroups());
      const nav = await screen.findByRole("navigation", { name: "Product types" });
      const [premium, game] = within(nav).getAllByRole("link");
      expect(premium).not.toHaveAttribute("aria-current");
      const observer = FakeIntersectionObserver.instances.at(-1)!;
      expect(observer.observed.map((el) => el.id)).toEqual(["g-premium-apps", "g-top-up-games"]);

      act(() => observer.show(["g-top-up-games"]));
      expect(game).toHaveAttribute("aria-current", "true");
      expect(premium).not.toHaveAttribute("aria-current");

      act(() => observer.show(["g-premium-apps", "g-top-up-games"]));
      expect(premium).toHaveAttribute("aria-current", "true");
      expect(game).not.toHaveAttribute("aria-current");

      act(() => observer.show([]));
      expect(premium).not.toHaveAttribute("aria-current");
      expect(game).not.toHaveAttribute("aria-current");
    });
  });

  describe("flash section", () => {
    it("shows the live flash cards with a See all link to /flash", async () => {
      const flashCard = card("netflix-flash", "Netflix Flash", { flash_discount: "20", flash_ends_at: new Date(Date.now() + 3_600_000).toISOString() });
      renderHome(homeFixture({ flash: [flashCard] }));
      const heading = await screen.findByRole("heading", { level: 2, name: "Flash sale" });
      const flash = heading.closest("section")!;
      expect(flash.id).toBe("flash");
      expect(within(flash).getByRole("heading", { name: "Netflix Flash" })).toBeInTheDocument();
      expect(within(flash).getByRole("link", { name: /See all/ })).toHaveAttribute("href", "/flash");
    });

    it("is hidden when no sale is live", async () => {
      const { container } = renderHome(homeFixture({ flash: [] }));
      await screen.findByRole("heading", { name: "Netflix Premium" });
      expect(container.querySelector("#flash")).toBeNull();
      expect(screen.queryByRole("heading", { level: 2, name: "Flash sale" })).not.toBeInTheDocument();
    });
  });

  describe("group sections", () => {
    it("splits a byCategory group into category sub-sections with jump chips and an 'others' heading", async () => {
      renderHome(homeFixture({ groups: [premiumByCategory(), gameGroup()] }));
      const group = (await screen.findByRole("heading", { level: 2, name: "💎 Premium Apps" })).closest("section")!;
      expect(group.id).toBe("g-premium-apps");

      // Named without the emoji, which a screen reader would read out.
      const chips = within(group).getByRole("navigation", { name: "Premium Apps" });
      expect(within(chips).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
        ["🎬 Streaming", "#g-premium-apps-c-streaming"],
        ["🎵 Music", "#g-premium-apps-c-music"],
        ["More Premium Apps", "#g-premium-apps-others"],
      ]);
      // Chips are plain anchors at the top of the section, not a second sticky bar.
      expect(chips.closest(".sticky")).toBeNull();

      const subHeadings = within(group).getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
      expect(subHeadings).toEqual(["🎬 Streaming", "Stream 1", "Stream 2", "Stream 3", "🎵 Music", "Tune 1", "Tune 2", "Tune 3", "More Premium Apps", "Tool 1", "Tool 2"]);
      const streaming = document.getElementById("g-premium-apps-c-streaming")!;
      expect(within(streaming).getAllByRole("link", { name: /Stream/ })).toHaveLength(3);
      expect(document.getElementById("g-premium-apps-others")).not.toBeNull();
    });

    it("renders a single-layout group as one grid with no chips or sub-headings", async () => {
      renderHome(twoGroups());
      const group = (await screen.findByRole("heading", { level: 2, name: "🎮 Top Up Games" })).closest("section")!;
      expect(group.id).toBe("g-top-up-games");
      expect(within(group).queryByRole("navigation")).not.toBeInTheDocument();
      expect(group.querySelectorAll(".grid")).toHaveLength(1);
      const grid = group.querySelector(".grid")!;
      expect(grid.className).toContain("grid-cols-2");
      expect(grid.className).toContain("sm:grid-cols-3");
      expect(grid.className).toContain("lg:grid-cols-4");
      expect(grid.className).toContain("xl:grid-cols-5");
      expect(within(group).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
        "Mobile Legends Diamonds",
        "Free Fire Diamonds",
      ]);
    });

    it("keeps each family's own card wording", async () => {
      renderHome(twoGroups());
      const premium = (await screen.findByRole("heading", { level: 2, name: "💎 Premium Apps" })).closest("section")!;
      const game = screen.getByRole("heading", { level: 2, name: "🎮 Top Up Games" }).closest("section")!;
      expect(premium.textContent).not.toMatch(/diamond|top up|player id|server/i);
      expect(game.textContent).not.toMatch(/premium|subscription|account|warranty/i);
      expect(game.textContent).toContain("Mobile Legends Diamonds");
    });

    it("shows a one-line notice above a section whose products are all sold out", async () => {
      const soldOut = [card("netflix-premium", "Netflix Premium", { available: 0, all_local_inventory: true })];
      renderHome(
        homeFixture({ groups: [premiumGroup({ sections: [section({ key: "all", products: soldOut, all_sold_out: true })] })] }),
      );
      const notice = await screen.findByText("Everything here is sold out for now.");
      const grid = screen.getByRole("heading", { name: "Netflix Premium" }).closest(".grid")!;
      expect(notice.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("shows no notice when the section has stock", async () => {
      renderHome(homeFixture());
      await screen.findByRole("heading", { name: "Netflix Premium" });
      expect(screen.queryByText("Everything here is sold out for now.")).not.toBeInTheDocument();
    });
  });

  describe("show more", () => {
    function streamingHome(total: number) {
      return homeFixture({
        groups: [
          premiumGroup({
            category_count: 2,
            single_category_slug: null,
            sections: [
              section({ key: "c-streaming", kind: "category", title: "Streaming", emoji: "🎬", category_slugs: ["streaming"], products: cards("Stream", 1, 10), total }),
              section({ key: "c-music", kind: "category", title: "Music", emoji: "🎵", category_slugs: ["music"], products: cards("Tune", 1, 3) }),
            ],
          }),
          gameGroup(),
        ],
      });
    }

    it("fetches the next 10 of that section with the ranking version and appends them", async () => {
      renderHome(streamingHome(25), pagedResponder("Stream", 25));
      const streaming = (await screen.findByRole("heading", { level: 3, name: "🎬 Streaming" })).closest("section")!;
      fireEvent.click(within(streaming).getByRole("button", { name: "Show more" }));
      expect(await within(streaming).findByRole("heading", { name: "Stream 20" })).toBeInTheDocument();
      expect(groupCalls()).toEqual(["/api/v1/pages/group/premium-apps?category=streaming&offset=10&limit=10&v=7"]);
      expect(within(streaming).getAllByRole("heading", { level: 3 })).toHaveLength(1 + 20);
    });

    it("joins every category of an 'others' or whole-group section into the request", async () => {
      const others = premiumByCategory();
      others.sections[2] = { ...others.sections[2]!, products: cards("Tool", 1, 10), total: 12 };
      renderHome(homeFixture({ groups: [others, gameGroup()] }), pagedResponder("Tool", 12));
      const section3 = (await screen.findByRole("heading", { level: 3, name: "More Premium Apps" })).closest("section")!;
      fireEvent.click(within(section3).getByRole("button", { name: "Show more" }));
      await within(section3).findByRole("heading", { name: "Tool 12" });
      expect(groupCalls()).toEqual(["/api/v1/pages/group/premium-apps?category=tools,vpn&offset=10&limit=10&v=7"]);
      // Everything is shown: no further button and no See all.
      expect(within(section3).queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
      expect(within(section3).queryByRole("link", { name: "See all" })).not.toBeInTheDocument();
    });

    // The server bumps the ranking version every few minutes and the home
    // query refetches on mount/focus — Back from a product page must find the
    // section still expanded, not collapsed to its first page.
    it("keeps an expanded section when a home refetch brings a new ranking version", async () => {
      const { queryClient, home } = renderHome(streamingHome(40), pagedResponder("Stream", 40));
      const streaming = (await screen.findByRole("heading", { level: 3, name: "🎬 Streaming" })).closest("section")!;
      fireEvent.click(within(streaming).getByRole("button", { name: "Show more" }));
      await within(streaming).findByRole("heading", { name: "Stream 20" });

      // New snapshot: version 8, and Stream 11 has climbed into the first page.
      const moved = streamingHome(40);
      const streamingSection = moved.groups[0]!.sections[0]!;
      streamingSection.products = [card("Stream-11", "Stream 11"), ...cards("Stream", 1, 9)];
      home.current = { ...moved, ranking_version: 8 };
      await act(() => queryClient.refetchQueries({ queryKey: ["home"] }));

      const section = screen.getByRole("heading", { level: 3, name: "🎬 Streaming" }).closest("section")!;
      // The refreshed first page is what renders first...
      await waitFor(() => expect(within(section).getAllByRole("heading", { level: 3 })[1]).toHaveTextContent("Stream 11"));
      // ...and the expanded cards are still there below it.
      expect(within(section).getByRole("heading", { name: "Stream 20" })).toBeInTheDocument();
      // 10 first-page cards + Stream 12..20 (Stream 11 is deduped). Stream 10
      // left the refreshed first page and was never in the cached expansion,
      // so it is not shown until "See all" — the accepted cost of keeping the
      // expansion instead of collapsing it.
      expect(within(section).getAllByRole("heading", { level: 3 })).toHaveLength(1 + 19);
      expect(within(section).getAllByRole("heading", { name: "Stream 11" })).toHaveLength(1);
      // Still one expansion used; the next page keeps the order it started with.
      fireEvent.click(within(section).getByRole("button", { name: "Show more" }));
      await within(section).findByRole("heading", { name: "Stream 30" });
      expect(groupCalls()).toEqual([
        "/api/v1/pages/group/premium-apps?category=streaming&offset=10&limit=10&v=7",
        "/api/v1/pages/group/premium-apps?category=streaming&offset=20&limit=10&v=7",
      ]);
    });

    it("drops products a moved ranking repeats", async () => {
      renderHome(streamingHome(25), () => groupPage([card("Stream-10", "Stream 10"), card("Stream-11", "Stream 11")], 12, 25));
      const streaming = (await screen.findByRole("heading", { level: 3, name: "🎬 Streaming" })).closest("section")!;
      fireEvent.click(within(streaming).getByRole("button", { name: "Show more" }));
      await within(streaming).findByRole("heading", { name: "Stream 11" });
      expect(within(streaming).getAllByRole("heading", { name: "Stream 10" })).toHaveLength(1);
    });

    it("caps at two expansions, then links a category sub-section to its category page", async () => {
      renderHome(streamingHome(40), pagedResponder("Stream", 40));
      const streaming = (await screen.findByRole("heading", { level: 3, name: "🎬 Streaming" })).closest("section")!;
      expect(within(streaming).queryByRole("link", { name: "See all" })).not.toBeInTheDocument();
      fireEvent.click(within(streaming).getByRole("button", { name: "Show more" }));
      await within(streaming).findByRole("heading", { name: "Stream 20" });
      fireEvent.click(within(streaming).getByRole("button", { name: "Show more" }));
      await within(streaming).findByRole("heading", { name: "Stream 30" });
      expect(groupCalls()[1]).toBe("/api/v1/pages/group/premium-apps?category=streaming&offset=20&limit=10&v=7");
      expect(within(streaming).queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
      expect(within(streaming).getByRole("link", { name: "See all" })).toHaveAttribute("href", "/c/streaming");
    });

    it("links a capped whole-group section to the group page, or to the only category's page", async () => {
      const big = (slug: string | null, count: number) =>
        gameGroup({
          category_count: slug ? 1 : 2,
          single_category_slug: slug,
          sections: [section({ key: "all", category_slugs: slug ? [slug] : ["mobile-legends", "free-fire"], products: cards("Game", 1, 10), total: count })],
        });
      const expand = async (group: HTMLElement) => {
        fireEvent.click(within(group).getByRole("button", { name: "Show more" }));
        await within(group).findByRole("heading", { name: "Game 20" });
        fireEvent.click(within(group).getByRole("button", { name: "Show more" }));
        await within(group).findByRole("heading", { name: "Game 30" });
      };

      const { unmount } = renderHome(homeFixture({ groups: [premiumGroup(), big(null, 50)] }), pagedResponder("Game", 50));
      let group = (await screen.findByRole("heading", { level: 2, name: "🎮 Top Up Games" })).closest("section")!;
      await expand(group);
      expect(within(group).getByRole("link", { name: "See all" })).toHaveAttribute("href", "/g/top-up-games");
      unmount();

      renderHome(homeFixture({ groups: [premiumGroup(), big("mobile-legends", 50)] }), pagedResponder("Game", 50));
      group = (await screen.findByRole("heading", { level: 2, name: "🎮 Top Up Games" })).closest("section")!;
      await expand(group);
      expect(within(group).getByRole("link", { name: "See all" })).toHaveAttribute("href", "/c/mobile-legends");
    });

    it("offers no button when the first page is the whole section", async () => {
      renderHome(twoGroups());
      await screen.findByRole("heading", { name: "Netflix Premium" });
      expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "See all" })).not.toBeInTheDocument();
    });
  });

  it("shows the empty catalog state when no group has products", async () => {
    renderHome(homeFixture({ groups: [], hero_products: [] }));
    expect(await screen.findByText("No products yet — check back soon.")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Product types" })).not.toBeInTheDocument();
  });

  it("renders the static Our Promise section with always-true wording and no customer-count or timing claims", async () => {
    const { container } = renderHome(homeFixture());
    const promiseHeading = await screen.findByRole("heading", { name: "What every order comes with" });
    const promiseSection = within(promiseHeading.closest("section")!);
    expect(promiseSection.getByText("Automatic delivery")).toBeInTheDocument();
    expect(promiseSection.getByText("Product-specific warranty")).toBeInTheDocument();
    // Nothing on the home page may promise what the shop cannot prove.
    const text = container.textContent ?? "";
    for (const claim of [/10,000/, /24\/7/, /24 hours/i, /under (an|1) hour/i, /Trusted by thousands/i, /Delivered in minutes/i, /\b1[–-]10 minutes/]) {
      expect(text).not.toMatch(claim);
    }
  });

  it("renders the four how-it-works steps as an ordered list", async () => {
    renderHome(homeFixture());
    expect(await screen.findByText("Four steps, done")).toBeInTheDocument();
    // An <ol> — the order of the steps is part of the meaning, not decoration.
    expect(document.querySelector("#how-to-order ol")?.children).toHaveLength(4);
    expect(screen.getByRole("heading", { name: "Choose your digital product" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Track fulfillment on your order" })).toBeInTheDocument();
  });

  it("renders the four trust points", async () => {
    renderHome(homeFixture());
    expect(await screen.findByText("Why buying here is safe")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Payments are verified by the system" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Reviews only come from orders that were really delivered" }),
    ).toBeInTheDocument();
  });

  it("renders all eleven FAQ entries as an accordion, with only the first expanded", async () => {
    renderHome(homeFixture());
    const faqHeading = await screen.findByRole("heading", { name: "Frequently asked questions" });
    const section = faqHeading.closest("section")!;
    const triggers = within(section).getAllByRole("button");
    expect(triggers).toHaveLength(11);
    // Native <details> is gone — each row is a <button aria-expanded>.
    expect(triggers[0]).toHaveAttribute("aria-expanded", "true");
    // A page that opened every answer would be an unreadable wall of text.
    expect(triggers.slice(1).every((b) => b.getAttribute("aria-expanded") === "false")).toBe(true);
    expect(within(section).getByText("Which network should I send USDT on?")).toBeInTheDocument();
  });

  it("expands an FAQ row on click and collapses the previously open one (single accordion)", async () => {
    renderHome(homeFixture());
    const faqHeading = await screen.findByRole("heading", { name: "Frequently asked questions" });
    const triggers = within(faqHeading.closest("section")!).getAllByRole("button");
    fireEvent.click(triggers[2]);
    expect(triggers[2]).toHaveAttribute("aria-expanded", "true");
    expect(triggers[0]).toHaveAttribute("aria-expanded", "false");
  });

  it("renders testimonials when present, and hides the section when empty", async () => {
    const { unmount } = renderHome(
      homeFixture({
        testimonials: [{ id: 1, name: "Ahmad F.", initial: "A", product: "Netflix Premium", rating: 5, comment: "Great service!" }],
      }),
    );
    expect(await screen.findByText("Ahmad F.")).toBeInTheDocument();
    expect(screen.getByText("“Great service!”")).toBeInTheDocument();
    unmount();

    renderHome(homeFixture({ testimonials: [] }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Netflix Premium" })).toBeInTheDocument());
    expect(screen.queryByText("What customers say")).not.toBeInTheDocument();
  });

  it("hides the WhatsApp contact card when wa_number is empty", async () => {
    renderHome(homeFixture({ wa_number: "" }));
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(screen.queryByText("WhatsApp")).not.toBeInTheDocument();
    // Telegram card still renders (bot_username is set) — contact section itself isn't hidden.
    expect(screen.getByText("Telegram")).toBeInTheDocument();
  });

  // The "Coming soon: Social Media Services" teaser advertised a service line
  // that does not exist, so the whole "Coming up" section is gone.
  it("does not advertise services that are not offered (no 'coming soon' teaser section)", async () => {
    const { container } = renderHome(homeFixture());
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(screen.queryByText("Social Media Services")).not.toBeInTheDocument();
    expect(screen.queryByText("Coming soon")).not.toBeInTheDocument();
    expect(screen.queryByText("Coming up")).not.toBeInTheDocument();
    expect(container.querySelectorAll(".border-dashed").length).toBe(0);
  });

  // Pins the "dead Telegram link" fix (fe9869a) now ported to React: never
  // render a https://t.me/ link with no username, and don't leave the
  // contact grid at a multi-column width sized for a card that isn't there.
  it("never renders a dead Telegram link when support_telegram_url is null (even with a bot username), and collapses the contact grid to 1 column with no WA card either", async () => {
    const { container } = renderHome(homeFixture({ support_telegram_url: null, wa_number: "" }));
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(screen.queryByText("Telegram")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /t\.me/ })).not.toBeInTheDocument();
    const grid = container.querySelector("#contact .grid.grid-cols-1");
    expect(grid).not.toBeNull();
    expect(grid?.className).not.toMatch(/sm:grid-cols-[23]/);
  });

  it("renders the Telegram contact from support_telegram_url, never from the bot username", async () => {
    renderHome(homeFixture({ bot_username: "realtoko_bot", support_telegram_url: "https://t.me/shop_help" }));
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(screen.getByRole("link", { name: /Telegram/ })).toHaveAttribute(
      "href",
      "https://t.me/shop_help",
    );
    expect(document.querySelector('a[href*="realtoko_bot"]')).toBeNull();
  });

  it("renders the hero image with the configured src when hero_image is set", async () => {
    renderHome(homeFixture({ hero_image: "https://x/img.jpg" }));
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(screen.getByAltText("")).toHaveAttribute("src", "https://x/img.jpg");
  });

  it("falls back to the plain gradient (no <img>) when hero_image is null", async () => {
    renderHome(homeFixture({ hero_image: null }));
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(screen.queryByAltText("")).not.toBeInTheDocument();
  });

  it("layers the hero background with two decorative glows, a texture overlay, and a vignette", async () => {
    const { container } = renderHome(homeFixture());
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const hero = container.querySelector("section.bg-ink");
    expect(hero).not.toBeNull();
    const decorative = hero!.querySelectorAll('[aria-hidden="true"]');
    // 1 top-right glow + 1 bottom-left glow + 1 dot-grid texture + 1 vignette = 4,
    // on top of whichever base gradient div (image or plain) also renders aria-hidden.
    expect(decorative.length).toBeGreaterThanOrEqual(4);
    expect(hero!.querySelector(".dot-grid")).not.toBeNull();
    expect(hero!.querySelector(".bg-grass\\/10")).not.toBeNull();
  });

  it("renders the hero CTAs as design-system buttons — pine-fill primary + dark-surface outline, both with the white focus ring", async () => {
    renderHome(twoGroups());
    // Two links, two purposes: browse the first group, or pick a product type.
    const primary = await screen.findByRole("link", { name: "Browse products" });
    const secondary = screen.getByRole("link", { name: "Shop by type" });
    expect(primary.className).toContain("btn-primary");
    expect(primary.className).toContain("focus-on-dark");
    // The primary CTA jumps to the first group; the secondary one to the group nav.
    expect(primary).toHaveAttribute("href", "#g-premium-apps");
    expect(secondary).toHaveAttribute("href", "#home-group-nav");
    expect(document.getElementById("home-group-nav")).not.toBeNull();
    // .btn-ghost (ink-soft on sand) is unreadable on bg-ink — the outline CTA
    // keeps a white border + white/15 hover instead (foundations.md §7).
    expect(secondary.className).toContain("hover:bg-white/15");
    expect(secondary.className).toContain("focus-on-dark");
    // The group nav lists groups, not categories — no CTA calls it "Categories".
    expect(screen.queryByRole("link", { name: "Categories" })).toBeNull();
  });

  it("labels the group-nav CTA and the group nav with their own keys in Indonesian", async () => {
    document.documentElement.lang = "id";
    renderHome(twoGroups());
    expect(await screen.findByRole("link", { name: "Pilih jenis produk" })).toHaveAttribute("href", "#home-group-nav");
    expect(screen.getByRole("navigation", { name: "Jenis produk" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Lihat produk" })).toHaveAttribute("href", "#g-premium-apps");
  });

  // The secondary CTA targets the group nav, which only renders with two or
  // more groups — without it, the link would scroll nowhere, so it is omitted.
  it("omits the hero group-nav CTA when there is only one group", async () => {
    renderHome(homeFixture());
    const links = await screen.findAllByRole("link", { name: "Browse products" });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "#g-premium-apps");
    expect(document.querySelector('a[href="#home-group-nav"]')).toBeNull();
  });

  // Catalog first — hero → group nav → flash → groups → features → how-to-order.
  it("orders the sections hero, group nav, flash, groups, features, how-to-order", async () => {
    const { container } = renderHome({ ...twoGroups(), flash: [card("netflix-flash", "Netflix Flash")] });
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const hero = container.querySelector("section.bg-ink")!;
    const nav = container.querySelector("#home-group-nav")!;
    const flash = container.querySelector("#flash")!;
    const premium = container.querySelector("#g-premium-apps")!;
    const game = container.querySelector("#g-top-up-games")!;
    const howTo = container.querySelector("#how-to-order")!;
    const features = screen.getByRole("heading", { level: 2, name: "Why shop with us?" }).closest("section")!;
    const follows = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(hero, nav)).toBe(true);
    expect(follows(nav, flash)).toBe(true);
    expect(follows(flash, premium)).toBe(true);
    expect(follows(premium, game)).toBe(true);
    expect(follows(game, features)).toBe(true);
    expect(follows(features, howTo)).toBe(true);
  });

  it("uses text-white/80, not text-ink-faint, for the hero sub-copy and trust chips on the dark surface", async () => {
    const { container } = renderHome(homeFixture());
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const hero = container.querySelector("section.bg-ink")!;
    expect(hero.querySelector("p.text-lg")!.className).toContain("text-white/80");
    expect(hero.querySelector("ul")!.className).toContain("text-white/80");
    expect(hero.querySelector("p.text-lg")!.className).not.toContain("text-ink-faint");
    expect(hero.querySelector("ul")!.className).not.toContain("text-ink-faint");
  });

  it("gives every home section heading the same text-2xl sm:text-3xl font-semibold scale", async () => {
    const { container } = renderHome({ ...twoGroups(), flash: [card("netflix-flash", "Netflix Flash")] });
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const h2s = Array.from(container.querySelectorAll("h2"));
    expect(h2s.length).toBeGreaterThanOrEqual(8);
    for (const h of h2s) {
      expect(h.className).toContain("text-2xl");
      expect(h.className).toContain("sm:text-3xl");
      expect(h.className).toContain("font-semibold");
      expect(h.className).not.toContain("font-bold");
    }
  });

  it("renders the hero trust chips through the shared TrustBadgeRow primitive", async () => {
    const { container } = renderHome(homeFixture());
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const hero = container.querySelector("section.bg-ink")!;
    const list = within(hero).getByRole("list");
    const labels = within(list)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(labels).toEqual(
      expect.arrayContaining(["Automatic delivery where available", "Payment options at checkout", "Product-specific warranty", "Help via support ticket"]),
    );
  });

  // "Instant delivery" is only true per product (auto plan with stock — the
  // ProductCard chip); the page-level copy must not promise it for everything.
  it("makes no blanket 'instant' promise anywhere on the home page", async () => {
    // Out of stock, so the (legitimately gated) product-card chip is absent too.
    const { container } = renderHome(homeFixture({ products: [{ ...product, available: 0 }] }));
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(container.textContent ?? "").not.toMatch(/delivered instantly|Instant delivery/i);
  });

  it("builds the hero product preview from hero_products, not from the section cards", async () => {
    const premiumLead = card("canva-pro", "Canva Pro");
    const gameLead = gameCard("ml-diamonds", "Mobile Legends Diamonds");
    const { container } = renderHome({ ...twoGroups(), hero_products: [premiumLead, gameLead] });
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const preview = container.querySelector('[data-testid="hero-product-preview"]');
    expect(preview).not.toBeNull();
    const cardLinks = preview!.querySelectorAll("a");
    expect(Array.from(cardLinks).map((a) => a.getAttribute("href"))).toEqual(["/p/canva-pro", "/p/ml-diamonds"]);
    expect(preview!.textContent).toContain("Canva Pro");
    expect(preview!.textContent).not.toContain("Netflix Premium");
  });

  it("renders an <img> with the product's image inside the hero product-preview card when one is set", async () => {
    const second = { ...product, slug: "spotify-premium", name: "Spotify Premium", image: "https://x/netflix.png" };
    const { container } = renderHome(homeFixture({ products: [product, second] }));
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const preview = container.querySelector('[data-testid="hero-product-preview"]');
    expect(preview).not.toBeNull();
    const img = preview!.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "https://x/netflix.png");
  });

  // T8/performance.md: these thumbnails sit next to the hero heading and are
  // visible on first paint (desktop), so `loading="lazy"` only delays what's
  // already in view — pins the eager fix alongside ProductPage's hero image.
  it("loads the hero product-preview thumbnails eagerly, not lazily", async () => {
    const second = { ...product, slug: "spotify-premium", name: "Spotify Premium", image: "https://x/netflix.png" };
    const { container } = renderHome(homeFixture({ products: [product, second] }));
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const preview = container.querySelector('[data-testid="hero-product-preview"]');
    const img = preview!.querySelector("img");
    expect(img).toHaveAttribute("loading", "eager");
  });

  // T8/performance.md: a real upload carries `image_srcset` (webpSrcset(),
  // widths from webpVariants.ts's PRODUCT_WIDTHS) — the 44px well should ask
  // for it via a <source>, sized to the slot rather than the 800w original.
  it("emits a sized <source> for the hero thumbnail when the product carries an image_srcset", async () => {
    const second = {
      ...product,
      slug: "spotify-premium",
      name: "Spotify Premium",
      image: "/uploads/products/spotify-abc.jpg",
      image_srcset: "/uploads/products/spotify-abc-400.webp 400w, /uploads/products/spotify-abc-800.webp 800w",
    };
    const { container } = renderHome(homeFixture({ products: [product, second] }));
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const preview = container.querySelector('[data-testid="hero-product-preview"]');
    const source = preview!.querySelector("source");
    expect(source).not.toBeNull();
    expect(source).toHaveAttribute("srcset", second.image_srcset);
    expect(source).toHaveAttribute("sizes", "44px");
    expect(source).toHaveAttribute("type", "image/webp");
  });

  // Seed/demo imagery (hotlinked Unsplash URLs) never has a local WebP
  // derivative — webpSrcset() returns null for it — so the thumbnail must
  // degrade to a plain <img> instead of an empty/broken <source>.
  it("renders no <source> for the hero thumbnail when the product has no image_srcset", async () => {
    const second = { ...product, slug: "spotify-premium", name: "Spotify Premium", image: "https://x/netflix.png" };
    const { container } = renderHome(homeFixture({ products: [product, second] }));
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const preview = container.querySelector('[data-testid="hero-product-preview"]');
    expect(preview!.querySelector("source")).toBeNull();
    expect(preview!.querySelector("img")).toHaveAttribute("src", "https://x/netflix.png");
  });

  it("caps the hero product-preview composition at three cards", async () => {
    const products = [
      product,
      { ...product, slug: "spotify-premium", name: "Spotify Premium" },
      { ...product, slug: "canva-pro", name: "Canva Pro" },
      { ...product, slug: "capcut-pro", name: "CapCut Pro" },
    ];
    const { container } = renderHome(homeFixture({ products, hero_products: products }));
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const preview = container.querySelector('[data-testid="hero-product-preview"]');
    expect(preview!.querySelectorAll("a").length).toBe(3);
  });

  it("hides the hero product-preview composition when fewer than two products are available", async () => {
    const { container } = renderHome(homeFixture({ products: [product] }));
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(container.querySelector('[data-testid="hero-product-preview"]')).toBeNull();
  });

  // STO-018: a single product in the 3-column grid used to leave two-thirds
  // of the row empty — clamp to a capped-width single column instead.
  it("clamps a section grid to one column when there's only one product", async () => {
    renderHome(homeFixture({ products: [product] }));
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const grid = screen.getByRole("heading", { name: "Netflix Premium" }).closest(".grid");
    expect(grid?.className).toContain("max-w-sm");
    // No `grid-cols-*` at all: a bare `grid-cols-2` would leave half the row empty.
    expect(grid?.className).not.toMatch(/grid-cols-/);
  });

  it("keeps the multi-column grid when there's more than one product", async () => {
    const second = { ...product, slug: "spotify-premium", name: "Spotify Premium" };
    renderHome(homeFixture({ products: [product, second] }));
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const grid = screen.getByRole("heading", { name: "Netflix Premium" }).closest(".grid");
    // H-05: same density as CategoryPage.
    expect(grid?.className).toContain("grid-cols-2");
    expect(grid?.className).toContain("sm:grid-cols-3");
    expect(grid?.className).toContain("lg:grid-cols-4");
    expect(grid?.className).toContain("xl:grid-cols-5");
    expect(grid?.className).toContain("gap-4");
  });

  // Flash sales: `from_price` already carries the discount, so the card only
  // adds the ⚡ badge (percent as text, not colour/emoji alone) and the
  // server-supplied pre-sale figure struck through beside it.
  it("shows the flash badge and the struck-through pre-sale price on a discounted card", async () => {
    const endsAt = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
    renderHome(
      homeFixture({
        products: [
          { ...product, flash_discount: "20", from_base_price: "98750", flash_ends_at: endsAt },
        ],
      }),
    );
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(screen.getByText(/Flash sale/)).toHaveTextContent("20%");
    expect(screen.getByText("Rp98,750")).toBeInTheDocument();
    expect(screen.getByText("Was Rp98,750")).toBeInTheDocument();
  });

  // The struck-through figure is a factual claim about what this plan used to
  // cost, so it is only ever the server's `from_base_price` — a card that
  // names a discount but carries no base price shows the badge alone rather
  // than inventing an original price from the percent.
  it("shows the badge but no struck-through price when the card carries no base price", async () => {
    const endsAt = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
    renderHome(homeFixture({ products: [{ ...product, flash_discount: "20", flash_ends_at: endsAt }] }));
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(screen.getByText(/Flash sale/)).toHaveTextContent("20%");
    expect(screen.queryByText(/^Was /)).not.toBeInTheDocument();
  });

  it("shows no flash badge or struck-through price when the card carries no flash sale", async () => {
    renderHome(homeFixture());
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(screen.queryByText(/Flash sale/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Was /)).not.toBeInTheDocument();
  });

  // A sale that has already ended must not leave a live badge (or a
  // strike-through against a price nothing beats) behind on a page left open.
  it("drops the live flash badge once flash_ends_at has passed", async () => {
    const endedAt = new Date(Date.now() - 60_000).toISOString();
    renderHome(homeFixture({ products: [{ ...product, flash_discount: "20", flash_ends_at: endedAt }] }));
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(screen.queryByText(/Flash sale/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Was /)).not.toBeInTheDocument();
  });

  // STO-006/performance.md: rendering nothing while the query is pending
  // reads as a blank/broken page — a skeleton signals "loading" instead.
  it("shows a loading skeleton before data arrives", async () => {
    let resolveData!: (value: unknown) => void;
    (apiGet as Mock).mockImplementation(async (path: string) => {
      if (path === "/api/v1/pages/context") return context;
      if (path === "/api/v1/pages/home") {
        return new Promise((resolve) => {
          resolveData = resolve;
        });
      }
      throw new Error(`unexpected path ${path}`);
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <HomePage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByLabelText("Loading…")).toBeInTheDocument();
    resolveData(homeFixture());
    expect(await screen.findByRole("heading", { name: "Netflix Premium" })).toBeInTheDocument();
  });

  // The catalog never waits on an observer: with one group there is no nav,
  // so nothing is observed at all, and the cards are there on first paint.
  it("shows the catalog and information without waiting for an intersection or timer", async () => {
    const observer = vi.fn();
    vi.stubGlobal("IntersectionObserver", observer);
    const { container } = renderHome(homeFixture());
    expect(await screen.findByRole("heading", { name: "Netflix Premium" })).toBeInTheDocument();
    expect(container.querySelector(".reveal")).toBeNull();
    expect(observer).not.toHaveBeenCalled();
  });
});
