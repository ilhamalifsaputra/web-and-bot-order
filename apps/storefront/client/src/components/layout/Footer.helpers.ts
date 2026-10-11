

/** Footer link row — keep in step with App.tsx's routes and with STATIC_PAGES
 * in apps/storefront/src/routes/spaShell.ts. One row here is a utility
 * destination rather than a policy page (/track). */
export const FOOTER_LINKS = [
  // The browse-all shelves are otherwise only linked from the mobile nav
  // drawer / bottom tab bar — this row is how a desktop visitor (and a
  // crawler) reaches them.
  { to: "/products", key: "web.products_title" },
  { to: "/categories", key: "web.categories_page_title" },
  { to: "/track", key: "web.track_title" },
  { to: "/help", key: "web.help_title" },
  { to: "/about", key: "web.about_title" },
  { to: "/contact", key: "web.contact_page_title" },
  { to: "/how-to-order", key: "web.hto_title" },
  { to: "/terms", key: "web.terms_title" },
  { to: "/privacy", key: "web.privacy_title" },
  { to: "/refund", key: "web.refund_title" },
];
