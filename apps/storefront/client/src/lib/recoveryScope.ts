/**
 * Which SPA routes an order-recovery (/track) session can actually use (H5,
 * UI-states audit).
 *
 * Such a session opens one order and nothing else: the server answers 404 for
 * every /api path outside a short allow-list (apps/storefront/src/plugins/
 * auth.ts). A page that needs any other endpoint would sit on its skeleton
 * forever, or show a false "product not found". This mirrors the server's list
 * as routes: the recovered order's page and pay page, /track itself, and the
 * informational pages, which read nothing but the shop context.
 */
const INFO_PAGES = new Set(["/track", "/about", "/contact", "/how-to-order", "/terms", "/privacy", "/refund"]);

export function recoveryScopeAllows(pathname: string, orderCode: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (INFO_PAGES.has(path)) return true;
  const own = encodeURIComponent(orderCode);
  return path === `/account/orders/${own}` || path === `/checkout/${own}/pay`;
}
