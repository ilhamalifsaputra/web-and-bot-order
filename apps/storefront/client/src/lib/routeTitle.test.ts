import { describe, it, expect, beforeEach } from "vitest";
import { routeTitle } from "./routeTitle";

const SHOP = "Toko Digital";

describe("routeTitle", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
  });

  it("leads with the shop name on the home page (matches spaShell.ts's headInfo)", () => {
    expect(routeTitle("/", "", SHOP)).toBe("Toko Digital — Digital products, delivered automatically after payment (where available)");
  });

  it("follows the <Page> — <Shop name> format for static routes", () => {
    expect(routeTitle("/cart", "", SHOP)).toBe("Cart — Toko Digital");
    expect(routeTitle("/checkout", "", SHOP)).toBe("Checkout — Toko Digital");
    expect(routeTitle("/login", "", SHOP)).toBe("Sign in — Toko Digital");
    expect(routeTitle("/about", "", SHOP)).toBe("About us — Toko Digital");
    expect(routeTitle("/privacy", "", SHOP)).toBe("Privacy Policy — Toko Digital");
  });

  it("titles the browse-all shelves", () => {
    expect(routeTitle("/products", "", SHOP)).toBe("All products — Toko Digital");
    expect(routeTitle("/categories", "", SHOP)).toBe("Categories — Toko Digital");
    expect(routeTitle("/flash", "", SHOP)).toBe("Flash sale — Toko Digital");
  });

  it("titles dynamic account/checkout paths without a lookup", () => {
    expect(routeTitle("/checkout/ABC123/pay", "", SHOP)).toBe("Payment — Toko Digital");
    expect(routeTitle("/account/orders/ABC123", "", SHOP)).toBe("My orders — Toko Digital");
    expect(routeTitle("/account/support/42", "", SHOP)).toBe("Help & support — Toko Digital");
    expect(routeTitle("/reset/some-token", "", SHOP)).toBe("Set a new password — Toko Digital");
  });

  it("echoes the query in the search title once one's present (STO-017 parity)", () => {
    expect(routeTitle("/search", "", SHOP)).toBe("Search products… — Toko Digital");
    expect(routeTitle("/search", "?q=netflix", SHOP)).toBe('Results for "netflix" — Toko Digital');
  });

  it("returns undefined for /p/:slug and /c/:slug — those pages title themselves", () => {
    expect(routeTitle("/p/netflix-premium", "", SHOP)).toBeUndefined();
    expect(routeTitle("/c/streaming", "", SHOP)).toBeUndefined();
  });

  it("falls back to a 404 title for a path outside the route table", () => {
    expect(routeTitle("/this-page-does-not-exist", "", SHOP)).toBe("404 — Toko Digital");
  });
});
