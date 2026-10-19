/**
 * A filled error `<Alert variant="destructive">`: rust tint and border, with
 * rust-dark text for the title/icon and the description. The admin pairs
 * `bg-rust-tint` with `text-rust-dark` elsewhere (status badges): plain rust
 * #dc2626 on #fde7e7 is only 4.08:1, rust-dark #b91c1c is 5.47:1 (WCAG AA).
 * The description selector matches the variant's own
 * `*:data-[slot=alert-description]:text-destructive/90`, so tailwind-merge
 * replaces it instead of keeping both.
 */
export const ERROR_ALERT_CLASS = "border-rust/40 bg-rust-tint text-rust-dark *:data-[slot=alert-description]:text-rust-dark";
