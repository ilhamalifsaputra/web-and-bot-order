import type { FastifyReply, FastifyRequest } from "fastify";
import { optionalAdmin } from "./auth";
import type { AdminSession } from "../auth";

/** Resolve the authenticated admin for an SSE route. Unlike `currentAdmin`
 * (303-redirects to /login, which EventSource cannot follow usefully),
 * this replies 401 and returns null on failure — callers MUST check for
 * null and return immediately without calling reply.hijack()/streamSse.
 * Pass `blockReadonly: true` for a stream exposing the same detail level
 * as a `blockReadonlyReads`-guarded GET sibling (see auth.ts). */
export async function requireSseAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
  opts?: { blockReadonly?: boolean },
): Promise<AdminSession | null> {
  const admin = await optionalAdmin(req);
  if (!admin) {
    reply.code(401).send();
    return null;
  }
  if (opts?.blockReadonly && admin.role === "readonly") {
    reply.code(403).send();
    return null;
  }
  return admin;
}
