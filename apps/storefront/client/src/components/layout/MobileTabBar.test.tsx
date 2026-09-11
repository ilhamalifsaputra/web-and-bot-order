import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import MobileTabBar, { TAB_BAR_HIDDEN_ROUTES } from "./MobileTabBar";

function renderBar(
  { cartCount = 0, isSignedIn = false }: { cartCount?: number; isSignedIn?: boolean },
  path = "/",
) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <MobileTabBar cartCount={cartCount} isSignedIn={isSignedIn} />
    </MemoryRouter>,
  );
}

const bar = () => screen.getByRole("navigation", { name: "Quick navigation" });

describe("MobileTabBar", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
  });

  it("renders the five primary destinations, routing a guest to /track and /login", () => {
    renderBar({ isSignedIn: false });
    const hrefs = within(bar())
      .getAllByRole("link")
      .map((l) => l.getAttribute("href"));
    expect(hrefs).toEqual(["/", "/search", "/cart", "/track", "/login"]);
  });

  it("routes a signed-in visitor's Pesanan/Akun tabs into the account area", () => {
    renderBar({ isSignedIn: true });
    const hrefs = within(bar())
      .getAllByRole("link")
      .map((l) => l.getAttribute("href"));
    expect(hrefs).toEqual(["/", "/search", "/cart", "/account/orders", "/account"]);
  });

  it("labels its five items Home / Search / Cart / Orders / Account", () => {
    renderBar({ isSignedIn: true });
    const names = within(bar())
      .getAllByRole("link")
      .map((l) => l.textContent);
    expect(names).toEqual(["Home", "Search", "Cart", "Orders", "Account"]);
  });

  it("marks exactly the active destination with aria-current=page", () => {
    renderBar({ isSignedIn: true }, "/account/orders/ORD-1");
    const current = within(bar())
      .getAllByRole("link")
      .filter((l) => l.getAttribute("aria-current") === "page");
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent("Orders");
  });

  it("lights the Home tab on the home route", () => {
    renderBar({}, "/");
    const current = within(bar())
      .getAllByRole("link")
      .filter((l) => l.getAttribute("aria-current") === "page");
    expect(current.map((l) => l.textContent)).toEqual(["Home"]);
  });

  it("shows the cart count as a badge on the Keranjang tab", () => {
    renderBar({ cartCount: 3 });
    expect(within(screen.getByRole("link", { name: /cart/i })).getByText("3")).toBeInTheDocument();
  });

  it("omits the badge when the cart is empty", () => {
    renderBar({ cartCount: 0 });
    expect(within(screen.getByRole("link", { name: /cart/i })).queryByText("0")).not.toBeInTheDocument();
  });

  it.each([
    "/p/some-slug",
    "/cart",
    "/checkout",
    "/checkout/ORD-1/pay",
    "/wallet/topup",
    "/wallet/topup/ORD-1/pay",
  ])("renders nothing on the full-funnel route %s", (path) => {
    const { container } = renderBar({}, path);
    expect(container).toBeEmptyDOMElement();
  });

  it("is present on ordinary routes such as a category page", () => {
    renderBar({}, "/c/games");
    expect(bar()).toBeInTheDocument();
  });

  it("keeps its hidden-route list in step with the six sticky-bar funnel screens", () => {
    expect([...TAB_BAR_HIDDEN_ROUTES]).toEqual([
      "/p/:slug",
      "/cart",
      "/checkout",
      "/checkout/:code/pay",
      "/wallet/topup",
      "/wallet/topup/:code/pay",
    ]);
  });
});
