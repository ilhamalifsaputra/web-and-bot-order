import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Footer from "./Footer";
import type { ShopContext } from "../../api/types";

function ctx(overrides: Partial<ShopContext> = {}): ShopContext {
  return {
    lang: "en",
    fx: "16000",
    shop_name: "Toko Digital",
    shop_tagline: "",
    cart_count: 0,
    customer: null,
    favicon_url: "/static/favicon.svg",
    logo_url: "",
    bot_username: null,
    wa_number: null,
    tzname: "Asia/Jakarta",
    ...overrides,
  } as ShopContext;
}

function renderFooter(c: ShopContext | undefined) {
  return render(
    <MemoryRouter>
      <Footer ctx={c} />
    </MemoryRouter>,
  );
}

const FULL: Partial<ShopContext> = {
  business: {
    legal_name: "PT Contoh Digital",
    address: "Jl. Mawar 1\nJakarta",
    phone: "+62 812-3456 789",
    email: "cs@contoh.id",
    hours: "09.00 - 21.00 WIB",
  },
  pay_methods: { qris: true, card: true },
  wa_number: "62811111",
  bot_username: "tokobot",
};

describe("Footer business identity", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
  });

  it("links to /contact", () => {
    renderFooter(ctx());
    expect(screen.getByRole("link", { name: "Contact us" })).toHaveAttribute("href", "/contact");
  });

  it("shows operator, address, contacts, payment marks and copyright when configured", () => {
    renderFooter(ctx(FULL));
    expect(screen.getByText("Operated by PT Contoh Digital")).toBeInTheDocument();
    expect(screen.getByText(/Jl\. Mawar 1/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /\+62 812-3456 789/ })).toHaveAttribute(
      "href",
      "tel:+628123456789",
    );
    expect(screen.getByRole("link", { name: /cs@contoh\.id/ })).toHaveAttribute(
      "href",
      "mailto:cs@contoh.id",
    );
    expect(screen.getByText("09.00 - 21.00 WIB")).toBeInTheDocument();
    expect(screen.getByText("Payment methods")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "QRIS" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Visa" })).toBeInTheDocument();
    expect(screen.getByText(`© ${new Date().getFullYear()} PT Contoh Digital`)).toBeInTheDocument();
  });

  it("hides every identity element when nothing is configured", () => {
    renderFooter(ctx());
    expect(screen.queryByText(/Operated by/)).not.toBeInTheDocument();
    expect(screen.queryByText("Payment methods")).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "QRIS" })).not.toBeInTheDocument();
    expect(screen.queryByText(/©/)).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
  });

  it("treats a missing context like nothing configured", () => {
    renderFooter(undefined);
    expect(screen.queryByText(/Operated by/)).not.toBeInTheDocument();
  });

  it("hides each field independently", () => {
    renderFooter(
      ctx({
        business: { legal_name: null, address: null, phone: null, email: "a@b.id", hours: null },
        pay_methods: { qris: false, card: false },
      }),
    );
    expect(screen.getByRole("link", { name: /a@b\.id/ })).toBeInTheDocument();
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
    expect(screen.queryByText("Payment methods")).not.toBeInTheDocument();
  });
});
