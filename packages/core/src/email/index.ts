/**
 * Public surface of the email design system. Consumers
 * (packages/outbox-dispatcher, apps/storefront) should only ever import
 * from this barrel, not reach into individual files.
 */
export * as layout from "./layout";
export * as components from "./components";
export * as theme from "./theme";
export { escapeHtml } from "./escape";
export * from "./registry";
export { renderEventNotification } from "./templates/eventNotification";
export { toAbsoluteAssetUrl } from "./assetUrl";
export { renderOrderPaidEmail } from "./templates/orderPaid";
export type { OrderPaidInput, OrderPaidItem } from "./templates/orderPaid";
export { renderOrderReadyEmail } from "./templates/orderReady";
export type { OrderReadyInput, OrderReadyItem } from "./templates/orderReady";
export { renderResetPasswordEmail, PASSWORD_RESET_EMAIL_COPY } from "./templates/resetPassword";
export type { ResetPasswordInput } from "./templates/resetPassword";
export { renderWalletTopupEmail } from "./templates/walletTopup";
export type { WalletTopupInput } from "./templates/walletTopup";
export type { BrandConfig, EmailCopy, RenderedEmail } from "./types";
export { renderEmailEventPreview } from "./templates/eventPreview";
