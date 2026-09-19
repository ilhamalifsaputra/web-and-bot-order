/**
 * Auth guards — port of deps.py's current_admin / optional_admin / csrf_protect
 * dependencies, expressed as Fastify preHandlers.
 *
 * `current_admin` redirects unauthenticated requests to /login (303). For
 * mutating routes, use `csrfProtect` (an ordered preHandler array): auth is
 * checked first (anon → 303 /login), then the CSRF token (bad → 403) — exactly
 * the FastAPI Depends(current_admin)→Depends(csrf_protect) ordering.
 */
import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyRequest, preHandlerHookHandler } from "fastify";
import { config } from "@app/core/config";
import { prisma, getSetting } from "@app/db";
import {
  readSession,
  sessionJtiKey,
  webRoleKey,
  isWebRole,
  DEFAULT_WEB_ROLE,
  constantTimeEqual,
  type AdminSession,
  type WebRole,
} from "../auth";

declare module "fastify" {
  interface FastifyRequest {
    admin: AdminSession | null;
  }
}

/** Current web role for a telegram id (settings-backed; unset ⇒ super). */
export async function loadWebRole(telegramId: number): Promise<WebRole> {
  const raw = await getSetting(prisma, webRoleKey(telegramId));
  return isWebRole(raw) ? raw : DEFAULT_WEB_ROLE;
}

async function verifySession(raw: string | undefined): Promise<AdminSession | null> {
  const data = readSession(raw);
  if (!data) return null;
  const storedJti = await getSetting(prisma, sessionJtiKey(data.telegramId));
  if (!storedJti || storedJti !== data.jti) return null;
  const role = await loadWebRole(data.telegramId);
  return { ...data, role };
}

/** Returns the verified admin or null without redirecting. */
export async function optionalAdmin(req: FastifyRequest): Promise<AdminSession | null> {
  const raw = req.cookies[config.WEB_COOKIE_NAME];
  return verifySession(raw);
}

// ---- RBAC: which roles may MUTATE which areas ------------------------------
// Reads (GET) are open to every authenticated admin by default; only
// mutations are gated by `canMutate` below. `blockReadonlyReads` (further
// down this file) is the documented exception: a small, explicitly-listed
// set of GET routes that return credentials or full CSV/JSON exports (order
// detail, stock credentials, orders/users/settings exports) is gated even
// for reads, refusing the `readonly` role specifically.

// Structural / money / account / high-impact routes — super only. All
// mutations now arrive at the JSON /api/* surface (the legacy form routes
// these prefixes originally matched were deleted once the React SPA became
// the only caller — see docs/audit-fitur-md-2026-07-04.md); these prefixes
// must track the live paths or every non-super role silently loses its RBAC
// grants (a real regression caught by the /api/* test-trio work).
// `/api/settlements` (task F1) is listed EXPLICITLY rather than left to
// `canMutate`'s default-deny, even though the default already produces
// super-only today. Recording a provider payout batch writes directly into the
// double-entry ledger — it is the entry that drains `provider_clearing` into
// `cash` — so it belongs with the money/structural surfaces beside
// `/api/users`'s wallet adjustment, and naming it here means a later change
// that adds it to `OPS_PREFIXES` has to argue with this list instead of
// silently widening the grant.
const CONFIG_PREFIXES = ["/api/catalog", "/api/vouchers", "/api/users", "/api/settings", "/api/stock", "/api/admins", "/api/broadcast", "/api/settlements"];
// Operational routes — super + support. `/api/admin-tasks` (the Task 9b
// queue: assign/start/complete/escalate on manual-ops tasks) sits here, not
// in CONFIG_PREFIXES — it's an operational queue like Support/Orders, not a
// structural/config surface, even though one task type (REFUND_REVIEW) is
// money-adjacent; the state machine itself only ever changes AdminTask.status/
// assignedTo, never moves money directly (that stays gated behind the
// existing Refund/wallet routes), so support-tier access is consistent with
// this repo's existing RBAC tiering rather than inventing a new one.
const OPS_PREFIXES = ["/api/orders", "/api/support", "/api/outbox", "/api/payments", "/api/reviews", "/api/admin-tasks"];

const underAny = (path: string, prefixes: string[]) =>
  prefixes.some((p) => path === p || path.startsWith(p + "/"));

/**
 * Whether `role` may perform a mutating request to `rawPath`. `rawPath` may
 * be a bare path or a full `req.url` (path + query string) — callers were
 * inconsistent about stripping the query string themselves (some pre-trim,
 * upload/branding/catalog routes pass `req.url` raw), which could silently
 * break an exact-match path check like `/settings/password` if it were ever
 * called with a query string. Normalizing once here removes that footgun for
 * every caller (Admin-4 fix, security audit 2026-06-23).
 */
export function canMutate(role: WebRole, rawPath: string): boolean {
  const path = (rawPath.split("?")[0] || rawPath) ?? "/";
  if (role === "super") return true;
  // Self-service for every authenticated admin: own password + own 2FA.
  if (path === "/api/settings/password" || path.startsWith("/api/settings/2fa/")) return true;
  if (role === "readonly") return false;
  // support: operational areas only (default-deny on anything unrecognized).
  return underAny(path, OPS_PREFIXES) && !underAny(path, CONFIG_PREFIXES);
}

/** preHandler: reject unauthenticated requests with a 303 redirect to /login. */
export const currentAdmin: preHandlerHookHandler = async (req, reply) => {
  const data = await optionalAdmin(req);
  if (!data) {
    return reply.code(303).redirect("/login");
  }
  req.admin = data;
};

/** Origin/Referer check — defense-in-depth ALONGSIDE csrfCheck's token check,
 * not a replacement. Compares the Origin header's hostname (or Referer's,
 * when Origin is absent) against the app's own configured public origin
 * (`ADMIN_PUBLIC_URL`) when one is set — mirroring the storefront's
 * originOk (routes/cart.ts) / publicBase (shop.ts) fallback shape. Only when
 * unconfigured does this fall back to this request's own hostname (Fastify's
 * req.hostname, which already respects TRUST_PROXY the same way req.ip
 * does — see storefront's rateLimit.ts's clientIp doc comment). Preferring
 * the configured origin avoids a deploy-time availability trap: a reverse
 * proxy that doesn't forward the `Host` header correctly would otherwise
 * make req.hostname disagree with the real public origin and 403 every
 * mutation. No Origin AND no Referer passes (many legitimate same-site
 * requests omit both); a header that IS present but names a different host
 * fails. */
function originOk(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const raw = typeof origin === "string" ? origin : typeof referer === "string" ? referer : null;
  if (raw === null) return true;
  const expectedHostname = config.ADMIN_PUBLIC_URL ? new URL(config.ADMIN_PUBLIC_URL).hostname : req.hostname;
  try {
    return new URL(raw).hostname === expectedHostname;
  } catch {
    return false; // an unparseable Origin/Referer is suspicious, not trusted
  }
}

const csrfCheck: preHandlerHookHandler = async (req, reply) => {
  const bodyToken = (req.body as Record<string, unknown> | undefined)?.csrf_token;
  const headerToken = req.headers["x-csrf-token"];
  const token = bodyToken ?? (typeof headerToken === "string" ? headerToken : undefined);
  if (
    typeof token !== "string" ||
    !req.admin ||
    !constantTimeEqual(token, req.admin.csrf) ||
    !originOk(req)
  ) {
    return reply.code(403).type("text/plain").send("CSRF check failed");
  }
};

/** RBAC gate: reject a mutation the current role isn't allowed to perform. */
const roleGate: preHandlerHookHandler = async (req, reply) => {
  const path = (req.url.split("?")[0] || req.url) ?? "/";
  if (!req.admin || !canMutate(req.admin.role, path)) {
    return reply.code(403).type("text/plain").send("Insufficient permissions for this action.");
  }
};

/** Ordered preHandlers for mutating routes: auth → CSRF → role gate. */
export const csrfProtect: preHandlerHookHandler[] = [currentAdmin, csrfCheck, roleGate];

/** Guard a read route as super-admin only (e.g. the /admins page). */
export const requireSuper: preHandlerHookHandler[] = [
  currentAdmin,
  async (req, reply) => {
    if (req.admin?.role !== "super") {
      return reply.code(403).type("text/plain").send("Super-admin only.");
    }
  },
];

/**
 * Guard a read route that exposes account credentials or a bulk export:
 * `readonly` is refused, `support` and `super` keep today's full access.
 * Reads were previously open to every authenticated admin (see the RBAC
 * note above `canMutate`); this narrows exactly the five credential/export
 * routes named in the C-1 finding (security audit 2026-08-21), rather than
 * changing what any read route or role can do more broadly.
 */
export const blockReadonlyReads: preHandlerHookHandler[] = [
  currentAdmin,
  async (req, reply) => {
    if (req.admin?.role === "readonly") {
      return reply.code(403).type("text/plain").send("This view isn't available to your role.");
    }
  },
];

const authPlugin: FastifyPluginAsync = async (app) => {
  app.decorateRequest("admin", null);
};

export default fp(authPlugin, { name: "auth" });

export type { AdminSession, WebRole };
