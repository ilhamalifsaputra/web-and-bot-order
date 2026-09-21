import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, waitFor, act, within, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import HomePage from "./HomePage";
import { apiGet } from "../api/client";
import type { HomePageData, ShopContext } from "../api/types";
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
  wa_number: null,
  tzname: "Asia/Jakarta",
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

function homeFixture(overrides: Partial<HomePageData> = {}): HomePageData {
  return {
    hero_image: null,
    categories: [
      { id: 1, name: "Streaming", slug: "streaming", emoji: "🎬", description: null, image: "", sortOrder: 0, isActive: true },
    ],
    products: [product],
    testimonials: [],
    low_threshold: 5,
    bot_username: "tokobot",
    wa_number: "6281234567890",
    ...overrides,
  };
}

function renderHome(data: HomePageData) {
  (apiGet as Mock).mockImplementation(async (path: string) => {
    if (path === "/api/v1/pages/context") return context;
    if (path === "/api/v1/pages/home") return data;
    throw new Error(`unexpected path ${path}`);
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("HomePage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  it("renders the hero, a product card, and a category pill", async () => {
    renderHome(homeFixture());
    expect(await screen.findByText("Digital products, delivered automatically after payment (where available)")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Netflix Premium" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View products/ })).toHaveAttribute("href", "/c/streaming");
  });

  it("gives category and contact cards a consistent lift-and-shadow hover treatment", async () => {
    renderHome(homeFixture());
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const categoryLink = screen.getByRole("link", { name: /View products/ });
    expect(categoryLink.className).toContain("hover:-translate-y-0.5");
    expect(categoryLink.className).toContain("hover:shadow-lift");

    const ticketLink = screen.getByRole("link", { name: /Support ticket/ });
    expect(ticketLink.className).toContain("hover:-translate-y-0.5");
    expect(ticketLink.className).toContain("hover:shadow-lift");
  });

  it("renders the static Our Promise section with always-true wording and no customer-count or timing claims", async () => {
    const { container } = renderHome(homeFixture());
    expect(await screen.findByText("What every order comes with")).toBeInTheDocument();
    expect(screen.getByText("Automatic delivery")).toBeInTheDocument();
    expect(screen.getByText("Warranty as listed")).toBeInTheDocument();
    // Nothing on the home page may promise what the shop cannot prove.
    const text = container.textContent ?? "";
    for (const claim of [/10,000/, /24\/7/, /24 hours/i, /under (an|1) hour/i, /Trusted by thousands/i, /Delivered in minutes/i, /1[–-]10 minutes/]) {
      expect(text).not.toMatch(claim);
    }
  });

  it("renders the four how-it-works steps as an ordered list", async () => {
    renderHome(homeFixture());
    expect(await screen.findByText("Four steps, done")).toBeInTheDocument();
    // An <ol> — the order of the steps is part of the meaning, not decoration.
    expect(document.querySelector("#how-to-order ol")?.children).toHaveLength(4);
    expect(screen.getByRole("heading", { name: "Pick a product & plan" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Credentials appear on your order" })).toBeInTheDocument();
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
        testimonials: [{ name: "Ahmad F.", initial: "A", product: "Netflix Premium", rating: 5, comment: "Great service!" }],
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
  it("never renders a dead Telegram link when bot_username is empty, and collapses the contact grid to 1 column with no WA card either", async () => {
    const { container } = renderHome(homeFixture({ bot_username: "", wa_number: "" }));
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(screen.queryByText("Telegram")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /t\.me/ })).not.toBeInTheDocument();
    const grid = container.querySelector("#contact .grid.grid-cols-1");
    expect(grid).not.toBeNull();
    expect(grid?.className).not.toMatch(/sm:grid-cols-[23]/);
  });

  it("renders the https://t.me/<username> Telegram link when bot_username is configured", async () => {
    renderHome(homeFixture({ bot_username: "realtoko_bot" }));
    await screen.findByRole("heading", { name: "Netflix Premium" });
    expect(screen.getByRole("link", { name: /Telegram/ })).toHaveAttribute(
      "href",
      "https://t.me/realtoko_bot",
    );
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
    renderHome(homeFixture());
    const primary = await screen.findByRole("link", { name: /Browse products/ });
    expect(primary.className).toContain("btn-primary");
    expect(primary.className).toContain("focus-on-dark");
    const secondary = screen.getByRole("link", { name: /Contact support/ });
    // .btn-ghost (ink-soft on sand) is unreadable on bg-ink — the outline CTA
    // keeps a white border + white/15 hover instead (foundations.md §7).
    expect(secondary.className).toContain("hover:bg-white/15");
    expect(secondary.className).toContain("focus-on-dark");
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
      expect.arrayContaining(["Automatic delivery where available", "QRIS & USDT", "Warranty per plan", "Help via support ticket"]),
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

  it("shows a hero product-preview composition when at least two products are available, linking each card to its product", async () => {
    const second = { ...product, slug: "spotify-premium", name: "Spotify Premium" };
    const { container } = renderHome(homeFixture({ products: [product, second] }));
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const preview = container.querySelector('[data-testid="hero-product-preview"]');
    expect(preview).not.toBeNull();
    const cardLinks = preview!.querySelectorAll("a");
    expect(cardLinks.length).toBe(2);
    expect(cardLinks[0]).toHaveAttribute("href", "/p/netflix-premium");
    expect(cardLinks[1]).toHaveAttribute("href", "/p/spotify-premium");
    expect(preview!.textContent).toContain("Netflix Premium");
    expect(preview!.textContent).toContain("Spotify Premium");
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
    const { container } = renderHome(homeFixture({ products }));
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
  it("clamps the Latest products grid to one column when there's only one product", async () => {
    const { container } = renderHome(homeFixture({ products: [product] }));
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const grid = screen.getByRole("heading", { name: "Netflix Premium" }).closest(".grid");
    expect(grid?.className).toContain("max-w-sm");
    expect(grid?.className).not.toMatch(/sm:grid-cols-2|lg:grid-cols-3/);
  });

  it("keeps the multi-column grid when there's more than one product", async () => {
    const second = { ...product, slug: "spotify-premium", name: "Spotify Premium" };
    renderHome(homeFixture({ products: [product, second] }));
    await screen.findByRole("heading", { name: "Netflix Premium" });
    const grid = screen.getByRole("heading", { name: "Netflix Premium" }).closest(".grid");
    expect(grid?.className).toMatch(/sm:grid-cols-2/);
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
    expect(screen.getByText("Rp98.750")).toBeInTheDocument();
    expect(screen.getByText("Was Rp98.750")).toBeInTheDocument();
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

  // A sale that has already ended must not leave a badge (or a strike-through
  // against a price nothing beats) behind on a page left open.
  it("hides the flash badge once flash_ends_at has passed", async () => {
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

  // STO-006: the scroll-reveal IntersectionObserver has no safety net for
  // non-scrolling consumers (screenshot tools, crawlers) — a timeout must
  // force every `.reveal` section visible even without an intersection.
  // jsdom doesn't implement IntersectionObserver at all (the component's own
  // "no IntersectionObserver" branch would reveal everything immediately),
  // so a no-op fake is installed here to exercise the "has IntersectionObserver
  // but it never fires" path the timeout exists for.
  it("forces .reveal sections visible after the fallback timeout even without an intersection firing", async () => {
    class NeverFiresObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
    vi.stubGlobal("IntersectionObserver", NeverFiresObserver);
    vi.useFakeTimers();
    try {
      const { container } = renderHome(homeFixture());
      // Flush the mocked apiGet promise + the resulting React effect without
      // relying on real timers (fake timers are active).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const reveals = container.querySelectorAll<HTMLElement>(".reveal");
      expect(reveals.length).toBeGreaterThan(0);
      expect(Array.from(reveals).some((r) => r.classList.contains("visible"))).toBe(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
      });
      expect(Array.from(reveals).every((r) => r.classList.contains("visible"))).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
