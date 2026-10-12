import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "@app/core/config";
import { createTelegramAuthIntent, consumeTelegramAuthIntent, prisma } from "@app/db";
import { constantTimeEqual } from "./auth";
import { loadSpaIndexHtml } from "./lib/spaFallback";
const COOKIE = "shop_telegram_intent";
export async function armTelegramCallback(reply: FastifyReply, purpose: "login" | "link", next: string): Promise<string> {
  const state = await createTelegramAuthIntent(prisma,purpose,next);
  void reply.header("Cache-Control","no-store").setCookie(COOKIE,state,{path:"/",httpOnly:true,sameSite:"lax",secure:config.WEB_COOKIE_SECURE,maxAge:15*60});
  return state;
}
export async function consumeTelegramCallback(req: FastifyRequest, reply: FastifyReply, purpose: "login" | "link", state: unknown, hash: string): Promise<{next:string}|null> {
  const cookie = req.cookies[COOKIE];
  if(typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state) || !cookie || !constantTimeEqual(cookie,state)) return null;
  void reply.clearCookie(COOKIE,{path:"/"});
  return consumeTelegramAuthIntent(prisma,state,purpose,hash);
}
/** Explicit callback shell preserves fragments until the early client adapter consumes them. */
export function telegramCallbackShell(reply: FastifyReply): FastifyReply {
  return reply.header("Cache-Control","no-store").header("Referrer-Policy","no-referrer").type("text/html; charset=utf-8").send(loadSpaIndexHtml().replace("__LANG__","en").replace("__TITLE__","Telegram sign in").replace("__CSRF_TOKEN__","").replace("<!--__HEAD_META__-->",'<meta name="referrer" content="no-referrer">').replace("<!--__SEO_BODY__-->",""));
}
