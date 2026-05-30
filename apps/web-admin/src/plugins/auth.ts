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
import { readSession, sessionJtiKey, type SessionData } from "../auth";

declare module "fastify" {
  interface FastifyRequest {
    admin: SessionData | null;
  }
}

async function verifySession(raw: string | undefined): Promise<SessionData | null> {
  const data = readSession(raw);
  if (!data) return null;
  const storedJti = await getSetting(prisma, sessionJtiKey(data.telegramId));
  if (!storedJti || storedJti !== data.jti) return null;
  return data;
}

/** Returns the verified admin or null without redirecting. */
export async function optionalAdmin(req: FastifyRequest): Promise<SessionData | null> {
  const raw = req.cookies[config.WEB_COOKIE_NAME];
  return verifySession(raw);
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

/** Ordered preHandlers for mutating routes: auth, then CSRF. */
export const csrfProtect: preHandlerHookHandler[] = [currentAdmin, csrfCheck];

const authPlugin: FastifyPluginAsync = async (app) => {
  app.decorateRequest("admin", null);
};

export default fp(authPlugin, { name: "auth" });

export type { SessionData };
