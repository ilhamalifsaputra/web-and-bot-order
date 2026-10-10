import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ShopContext } from "../api/types";
import BrandLogo from "./BrandLogo";

const ctx = { shop_name: "Trustance", logo_url: "/uploads/branding/owner.png" } as ShopContext;
describe("BrandLogo", () => {
  it("uses owner settings, reserves image space and recovers from a missing asset", () => {
    const { rerender } = render(<BrandLogo ctx={ctx} />);
    const image = screen.getByRole("img", { name: "Trustance" });
    expect(image).toHaveAttribute("src", ctx.logo_url);
    expect(image).toHaveAttribute("width", "44");
    expect(image).toHaveAttribute("height", "44");
    fireEvent.error(image);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("Trustance")).toBeVisible();
    rerender(<BrandLogo ctx={{ ...ctx, logo_url: "/uploads/branding/replacement.png" }} />);
    expect(screen.getByRole("img", { name: "Trustance" })).toHaveAttribute("src", "/uploads/branding/replacement.png");
  });
  it("uses a text wordmark when there is no approved logo", () => {
    render(<BrandLogo ctx={{ ...ctx, logo_url: "" }} />);
    expect(screen.getByText("Trustance")).toBeVisible();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
