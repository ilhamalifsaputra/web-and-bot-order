import { describe, it, expect } from "vitest";
import {
  title,
  subtitle,
  divider,
  statusBadge,
  infoTable,
  primaryButton,
  fallbackLinkLine,
  alertBox,
  footer,
} from "./components";
import type { BrandConfig } from "./types";

describe("title", () => {
  it("renders the given text", () => {
    expect(title("You've got a new order")).toContain("You&#x27;ve got a new order");
  });

  it("escapes malicious text", () => {
    expect(title("<script>alert(1)</script>")).not.toContain("<script>");
  });
});

describe("subtitle", () => {
  it("renders the given text", () => {
    expect(subtitle("A customer just paid")).toContain("A customer just paid");
  });

  it("escapes malicious text", () => {
    expect(subtitle("<script>alert(1)</script>")).not.toContain("<script>");
  });
});

describe("divider", () => {
  it("renders a table row", () => {
    expect(divider()).toContain("<tr");
  });
});

describe("statusBadge", () => {
  it("renders each tone with the correct color", () => {
    expect(statusBadge("PAID", "success")).toContain("#16A34A");
    expect(statusBadge("PENDING", "warning")).toContain("#F59E0B");
    expect(statusBadge("FAILED", "danger")).toContain("#DC2626");
  });

  it("renders a neutral-tone badge with a gray color", () => {
    const html = statusBadge("N/A", "neutral");
    expect(html).toContain("N/A");
    expect(html).not.toContain("#16A34A");
    expect(html).not.toContain("#F59E0B");
    expect(html).not.toContain("#DC2626");
  });

  it("renders the given text", () => {
    expect(statusBadge("PAID", "success")).toContain("PAID");
  });

  it("escapes malicious text", () => {
    expect(statusBadge("<script>alert(1)</script>", "success")).not.toContain("<script>alert");
  });
});

describe("infoTable", () => {
  it("renders label/value pairs as rows", () => {
    const html = infoTable([
      { label: "Order", value: "ORD-1" },
      { label: "Total", value: "100 USDT" },
    ]);
    expect(html).toContain("Order");
    expect(html).toContain("ORD-1");
    expect(html).toContain("Total");
    expect(html).toContain("100 USDT");
  });

  it("skips a row entirely when value is empty", () => {
    const html = infoTable([
      { label: "Order", value: "ORD-1" },
      { label: "Coupon", value: "" },
    ]);
    expect(html).not.toContain("Coupon");
  });

  it("escapes malicious label/value text", () => {
    const html = infoTable([{ label: "<script>x</script>", value: "<script>y</script>" }]);
    expect(html).not.toContain("<script>x</script>");
    expect(html).not.toContain("<script>y</script>");
  });

  it("renders nothing but a valid empty table for an empty row list", () => {
    expect(() => infoTable([])).not.toThrow();
  });
});

describe("primaryButton", () => {
  it("contains the given href", () => {
    const html = primaryButton("View Order", "https://example.com/orders/1", "#4F46E5");
    expect(html).toContain("https://example.com/orders/1");
  });

  it("contains an aria-label matching the button text", () => {
    const html = primaryButton("View Order", "https://example.com/orders/1", "#4F46E5");
    expect(html).toContain('aria-label="View Order"');
  });

  it("uses the given accent color as the button background", () => {
    const html = primaryButton("View Order", "https://example.com/orders/1", "#00A86B");
    expect(html).toContain("background-color:#00A86B");
  });

  it("escapes malicious button text, href, and accent color", () => {
    const html = primaryButton(
      "<script>x</script>",
      "javascript:alert(1)\"><script>y</script>",
      '"><script>z</script>',
    );
    expect(html).not.toContain("<script>x</script>");
    expect(html).not.toContain("<script>y</script>");
    expect(html).not.toContain("<script>z</script>");
  });
});

describe("fallbackLinkLine", () => {
  it("shows the visible URL text", () => {
    const html = fallbackLinkLine("https://example.com/reset/abc");
    expect(html).toContain("https://example.com/reset/abc");
    expect(html).toContain("If the button doesn't work");
  });

  it("escapes a malicious href", () => {
    const html = fallbackLinkLine('https://example.com/"><script>alert(1)</script>');
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

describe("alertBox", () => {
  it("renders a warning-tone box with the tinted background", () => {
    const html = alertBox("Didn't request this?", "You can safely ignore this email.", "warning");
    expect(html).toContain("#F59E0B");
    expect(html).toContain("Didn&#x27;t request this?");
    expect(html).toContain("You can safely ignore this email.");
  });

  it("renders an info-tone box", () => {
    const html = alertBox("Heads up", "Some info.", "info");
    expect(html).toContain("Heads up");
    expect(html).toContain("Some info.");
  });

  it("escapes malicious title/message", () => {
    const html = alertBox("<script>x</script>", "<script>y</script>", "warning");
    expect(html).not.toContain("<script>x</script>");
    expect(html).not.toContain("<script>y</script>");
  });
});

describe("footer", () => {
  const brand: BrandConfig = {
    shopName: "Acme Shop",
    logoUrl: null,
    accentColor: "#4F46E5",
    supportEmail: null,
    storeUrl: null,
  };

  it("renders both optional lines when both are present", () => {
    const html = footer(
      { ...brand, supportEmail: "support@acme.test", storeUrl: "https://acme.test" },
      { generatedByLine: "This is an automated email." },
    );
    expect(html).toContain("support@acme.test");
    expect(html).toContain("https://acme.test");
    expect(html).toContain("This is an automated email.");
  });

  it("renders only the support line when only supportEmail is present", () => {
    const html = footer(
      { ...brand, supportEmail: "support@acme.test", storeUrl: null },
      { generatedByLine: "This is an automated email." },
    );
    expect(html).toContain("support@acme.test");
    expect(html).not.toContain("https://acme.test");
  });

  it("renders only the store line when only storeUrl is present", () => {
    const html = footer(
      { ...brand, supportEmail: null, storeUrl: "https://acme.test" },
      { generatedByLine: "This is an automated email." },
    );
    expect(html).not.toContain("Need help?");
    expect(html).toContain("https://acme.test");
  });

  it("renders neither optional line when both are absent", () => {
    const html = footer(
      { ...brand, supportEmail: null, storeUrl: null },
      { generatedByLine: "This is an automated email." },
    );
    expect(html).not.toContain("Need help?");
    expect(html).not.toContain("acme.test");
    expect(html).toContain("This is an automated email.");
  });

  it("escapes the generatedByLine", () => {
    const html = footer(brand, { generatedByLine: "<script>alert(1)</script>" });
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});
