/**
 * Preview email templates in a browser by rendering them to HTML files.
 *
 * Generates sample Order Paid and Reset Password emails with realistic
 * fixture data and writes them to tmp/email-preview/ for inspection.
 *
 * Run: pnpm exec tsx scripts/preview-emails.ts
 */
import * as fs from "fs";
import * as path from "path";
import { renderOrderPaidEmail, renderResetPasswordEmail } from "@app/core/email";
import type { OrderPaidInput, BrandConfig, EmailCopy } from "@app/core/email";
import type { ResetPasswordInput } from "@app/core/email";

// Sample BrandConfig — customize these values to match your shop
const brand: BrandConfig = {
  shopName: "Trustance",
  logoUrl: "https://trustance.example/logo.png",
  accentColor: "#4F46E5",
  supportEmail: "support@trustance.example",
  storeUrl: "https://trustance.example",
};

// Default copy for Order Paid email (from resolveOrderPaidCopy defaults)
const orderPaidCopy: EmailCopy = {
  subject: "New paid order",
  title: "You've got a new order",
  subtitle: "A customer just completed payment.",
  message: "Here are the details.",
};

// Default copy for Reset Password email (English-only HTML, bilingual text)
const resetPasswordCopy: EmailCopy = {
  subject: "Reset your password",
  title: "Password reset requested",
  subtitle: "Someone requested a password reset for your account.",
  message:
    "Click the button below to set a new password. If you didn't request this, you can safely ignore this email.",
};

// Realistic Order Paid fixture with all optional fields populated
const orderPaidInput: OrderPaidInput = {
  orderCode: "ORD-2026-08-001234",
  orderId: 567,
  customerLabel: "John Doe (john.doe@example.com)",
  items: [
    {
      name: "Premium Membership",
      variant: "1 Year",
      quantity: 1,
      unitPrice: "2500000",
    },
    {
      name: "Extended Warranty",
      variant: "24 months",
      quantity: 1,
      unitPrice: "500000",
    },
    {
      name: "Premium Support",
      variant: "Standard",
      quantity: 2,
      unitPrice: "200000",
    },
  ],
  subtotal: "3400000",
  discount: "340000",
  total: "3060000",
  currency: "IDR",
  paymentMethod: "Bank Transfer",
  transactionId: "TRX-20260807-ABC12345",
  voucherCode: "SUMMER2026",
  paidAt: "2026-08-07 14:30 UTC",
  orderUrl: "https://trustance.example/orders/ORD-2026-08-001234",
};

// Realistic Reset Password fixture with all optional fields populated
const resetPasswordInput: ResetPasswordInput = {
  resetUrl:
    "https://trustance.example/auth/reset-password?token=abc123def456xyz789",
  expiryMinutes: 60,
  requestedAt: "2026-08-07 14:25 UTC",
  ip: "203.0.113.42",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

async function main(): Promise<void> {
  try {
    // Create output directory
    const outDir = path.resolve("tmp", "email-preview");
    fs.mkdirSync(outDir, { recursive: true });

    // Render Order Paid email
    const orderPaidRendered = renderOrderPaidEmail(
      orderPaidInput,
      brand,
      orderPaidCopy,
    );
    const orderPaidPath = path.join(outDir, "order-paid.html");
    fs.writeFileSync(orderPaidPath, orderPaidRendered.html, "utf-8");
    console.log(`✓ Order Paid email: ${orderPaidPath}`);

    // Render Reset Password email
    const resetPasswordRendered = renderResetPasswordEmail(
      resetPasswordInput,
      brand,
      resetPasswordCopy,
    );
    const resetPasswordPath = path.join(outDir, "reset-password.html");
    fs.writeFileSync(resetPasswordPath, resetPasswordRendered.html, "utf-8");
    console.log(`✓ Reset Password email: ${resetPasswordPath}`);

    console.log("\nBoth email previews generated successfully.");
    console.log("Open the HTML files in your browser to preview the design.\n");
  } catch (error) {
    console.error(
      "Failed to generate email previews:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  }
}

main();
