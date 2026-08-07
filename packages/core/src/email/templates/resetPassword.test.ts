import { describe, it, expect } from "vitest";
import { renderResetPasswordEmail } from "./resetPassword";
import type { ResetPasswordInput } from "./resetPassword";
import type { BrandConfig, EmailCopy } from "../types";

const brand: BrandConfig = {
  shopName: "Acme Shop",
  logoUrl: null,
  accentColor: "#4F46E5",
  supportEmail: "support@acme.test",
  storeUrl: "https://acme.test",
};

const defaultCopy: EmailCopy = {
  subject: "{shop_name} — reset your password",
  title: "Reset your password",
  subtitle: "We received a request to reset your password.",
  message: "Click the button below to choose a new password. This link expires in 1 hour.",
};

const fullInput: ResetPasswordInput = {
  resetUrl: "https://acme.test/reset/abc123token",
  expiryMinutes: 60,
  requestedAt: "2026-08-07 10:00 UTC",
  ip: "203.0.113.5",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
};

describe("renderResetPasswordEmail — full fixture", () => {
  const result = renderResetPasswordEmail(fullInput, brand, defaultCopy);

  it("includes the reset link", () => {
    expect(result.html).toContain("https://acme.test/reset/abc123token");
    expect(result.text).toContain("https://acme.test/reset/abc123token");
  });

  it("includes the expiry text", () => {
    expect(result.html).toContain("60");
    expect(result.text).toContain("60");
  });

  it("includes the IP", () => {
    expect(result.html).toContain("203.0.113.5");
  });

  it("includes the request time", () => {
    expect(result.html).toContain("2026-08-07 10:00 UTC");
  });

  it("includes the escaped raw User-Agent as the Device line", () => {
    expect(result.html).toContain("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
  });
});

describe("renderResetPasswordEmail — null ip/userAgent", () => {
  const minimalInput: ResetPasswordInput = { ...fullInput, ip: null, userAgent: null };

  it("renders without crashing and omits the Device row", () => {
    expect(() => renderResetPasswordEmail(minimalInput, brand, defaultCopy)).not.toThrow();
    const result = renderResetPasswordEmail(minimalInput, brand, defaultCopy);
    expect(result.html).not.toContain("Device");
    expect(result.html.toLowerCase()).not.toContain("null");
    expect(result.html.toLowerCase()).not.toContain("undefined");
  });

  it("omits the IP row too", () => {
    const result = renderResetPasswordEmail(minimalInput, brand, defaultCopy);
    expect(result.html).not.toContain("203.0.113.5");
  });
});

describe("renderResetPasswordEmail — bilingual text fallback", () => {
  const result = renderResetPasswordEmail(fullInput, brand, defaultCopy);

  it("text output contains both an English and an Indonesian paragraph", () => {
    expect(result.text).toMatch(/valid|expires|reset/i);
    expect(result.text).toMatch(/kata sandi|kadaluarsa|berlaku/i);
  });
});

describe("renderResetPasswordEmail — XSS escaping", () => {
  it("escapes a User-Agent value containing <script> in html", () => {
    const maliciousInput: ResetPasswordInput = {
      ...fullInput,
      userAgent: "<script>alert(1)</script>",
    };
    const result = renderResetPasswordEmail(maliciousInput, brand, defaultCopy);
    expect(result.html).not.toContain("<script>alert(1)</script>");
  });
});

describe("renderResetPasswordEmail — subject", () => {
  it("substitutes {shop_name} from brand", () => {
    const result = renderResetPasswordEmail(fullInput, brand, defaultCopy);
    expect(result.subject).toBe("Acme Shop — reset your password");
  });
});

describe("renderResetPasswordEmail — brand accent color", () => {
  it("uses the brand's accent color as the Reset Password button background", () => {
    const brandedAccent: BrandConfig = { ...brand, accentColor: "#00A86B" };
    const result = renderResetPasswordEmail(fullInput, brandedAccent, defaultCopy);
    // Matches primaryButton's exact bulletproof-button markup, not just any
    // "background-color:#00A86B" occurrence (the header accent rule also
    // carries the accent color, so a bare toContain would false-positive).
    expect(result.html).toContain('background-color:#00A86B;" class="email-button-bg"');
  });
});
