/**
 * Customer auth guards — mirror of web-admin's plugins/auth.ts for shoppers:
 * `currentCustomer` redirects anonymous requests to /login (303);
 * `csrfProtect` = auth + CSRF token check for mutating routes.
 * The session is server-verifiable: cookie jti must match the settings row
 * (logout rotates it), and banned users are treated as logged out.
 */
import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyRequest, preHandlerHookHandler } from "fastify";
import { prisma, getSetting, getUser } from "@app/db";
import {
  readCustomerSession,
  shopSessionJtiKey,
  SHOP_COOKIE_NAME,
  type CustomerSession,
} from "../auth";

/** req.customer: the cookie payload + the freshly loaded user row. */
export type Customer = CustomerSession & {
  user: NonNullable<Awaited<ReturnType<typeof getUser>>>;
};

declare module "fastify" {
  interface FastifyRequest {
    customer: Customer | null;
  }
}

/** Verified customer or null — no redirect (for pages that work anonymous). */
export async function optionalCustomer(req: FastifyRequest): Promise<Customer | null> {
  const data = readCustomerSession(req.cookies[SHOP_COOKIE_NAME]);
  if (!data) return null;
  const storedJti = await getSetting(prisma, shopSessionJtiKey(data.userId));
  if (!storedJti || storedJti !== data.jti) return null;
  const user = await getUser(prisma, data.userId);
  if (!user || user.banned) return null;
  return { ...data, user };
}

/** preHandler: redirect anonymous requests to /login (keeps the target path). */
export const currentCustomer: preHandlerHookHandler = async (req, reply) => {
  const customer = await optionalCustomer(req);
  if (!customer) {
    const next = encodeURIComponent(req.url);
    return reply.code(303).redirect(`/login?next=${next}`);
  }
  req.customer = customer;
};

const csrfCheck: preHandlerHookHandler = async (req, reply) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const token = body.csrf_token ?? req.headers["x-csrf-token"];
  if (!token || token !== req.customer?.csrf) {
    return reply.code(403).type("text/plain").send("CSRF check failed");
  }
};

/** Ordered preHandlers for mutating customer routes: auth → CSRF. */
export const csrfProtect: preHandlerHookHandler[] = [currentCustomer, csrfCheck];

const authPlugin: FastifyPluginAsync = async (app) => {
  app.decorateRequest("customer", null);
};

export default fp(authPlugin, { name: "storefront-auth" });
