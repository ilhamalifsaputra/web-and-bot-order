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
// Reads (GET) are open to every authenticated admin; only mutations are gated.

// Structural / money / account / high-impact routes — super only.
const CONFIG_PREFIXES = ["/catalog", "/vouchers", "/users", "/settings", "/stock", "/admins", "/broadcast"];
// Operational routes — super + support.
const OPS_PREFIXES = ["/orders", "/support", "/outbox", "/payments", "/reviews"];

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
  if (path === "/settings/password" || path.startsWith("/settings/2fa/")) return true;
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

const csrfCheck: preHandlerHookHandler = async (req, reply) => {
  const token = (req.body as Record<string, unknown> | undefined)?.csrf_token;
  if (!token || token !== req.admin?.csrf) {
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

const authPlugin: FastifyPluginAsync = async (app) => {
  app.decorateRequest("admin", null);
};

export default fp(authPlugin, { name: "auth" });

export type { AdminSession, WebRole };
