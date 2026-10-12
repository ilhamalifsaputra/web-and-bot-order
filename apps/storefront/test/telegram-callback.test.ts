import "./setup-env";
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { prisma, initDb, setSetting } from "@app/db";
import { buildApp } from "../src/server";
import { resetLoginAttempts } from "../src/rateLimit";
import { SHOP_COOKIE_NAME, makeCustomerSession, newJti, shopSessionJtiKey } from "../src/auth";
let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => { await initDb(); await setSetting(prisma, "setup_completed", "true"); app = await buildApp(); await prisma.user.create({data:{telegramId:881100n, referralCode:"TGCALLBACK"}}); });
afterAll(async () => { await app?.close(); await prisma.$disconnect(); });
beforeEach(() => { resetLoginAttempts("127.0.0.1"); resetLoginAttempts("telegram-start:127.0.0.1"); });
function signed(id = 881100, authDate = Math.floor(Date.now()/1000)) {
  const fields = { id: String(id), first_name: "Buyer", auth_date: String(authDate) };
  const hash = createHmac("sha256", createHash("sha256").update(process.env.BOT_TOKEN!).digest()).update(Object.entries(fields).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join("\n")).digest("hex");
  return {...fields, hash};
}
async function start() { const r = await app.inject({url:"/api/v1/auth/telegram-widget?next=%2Faccount"}); return { state: new URL(r.json().auth_url,"http://localhost").searchParams.get("state"), cookie: String(r.headers["set-cookie"]).split(";")[0]! }; }
describe("Telegram callback security", () => {
  it("links the verified fragment POST only after this signed-in account arms a link", async () => {
    const user=await prisma.user.create({data:{loginUsername:"tg-post-link",email:"tg-post-link@example.com",referralCode:"TGPOSTLINK"}});
    const jti=newJti();await setSetting(prisma,shopSessionJtiKey(user.id),jti);
    const session=makeCustomerSession(user.id,null,jti);
    const cookie=`${SHOP_COOKIE_NAME}=${session.raw}`;
    const start=await app.inject({method:"POST",url:"/api/v1/account/settings/link-telegram/start",headers:{cookie,"x-csrf-token":session.data.csrf},payload:{}});
    expect(start.statusCode).toBe(200);
    const state=new URL(start.json().auth_url,"http://localhost").searchParams.get("state");
    const linkCookie=`${cookie}; ${String(start.headers["set-cookie"]).split(";")[0]}`;
    const request={method:"POST" as const,url:"/account/settings/link-telegram",headers:{cookie:linkCookie},payload:{...signed(881105),state}};
    const linked=await app.inject(request);
    expect(linked.statusCode).toBe(200);expect(linked.json()).toEqual({redirect:"/account/settings?linked=1"});
    expect((await prisma.user.findUniqueOrThrow({where:{id:user.id}})).telegramId).toBe(881105n);
    expect((await app.inject(request)).json()).toEqual({redirect:"/account/settings?err=tg_invalid"});
    expect(await prisma.auditLog.count({where:{action:"account_link_telegram",customerId:user.id}})).toBe(1);
  });
  it("supports a first web session for an existing bot identity using signed GET compatibility", async () => {
    await prisma.user.create({data:{telegramId:881104n,referralCode:"TGLEGACY"}});
    const intent=await start();
    const r=await app.inject({url:`/auth/telegram?${new URLSearchParams({...signed(881104),state:intent.state!})}`,headers:{cookie:intent.cookie}});
    expect(r.statusCode).toBe(303);expect(r.headers.location).toBe("/account");
    expect(String(r.headers["set-cookie"])).toContain(SHOP_COOKIE_NAME);
    expect(r.headers["cache-control"]).toBe("no-store");expect(r.headers["referrer-policy"]).toBe("no-referrer");
  });
  it("does not copy signed link callback query fields into the anonymous login URL", async () => {
    const r=await app.inject({url:`/account/settings/link-telegram?${new URLSearchParams({...signed(),state:"browser-state"})}`});
    expect(r.statusCode).toBe(303);expect(r.headers.location).toBe("/login?next=%2Faccount%2Fsettings");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
  });
  it("requires both matching browser cookie and state even for valid Telegram authentication", async () => {
    const intent=await start();
    for(const request of [{headers:{cookie:intent.cookie},payload:{...signed()}},{headers:{},payload:{...signed(),state:intent.state}},{headers:{cookie:intent.cookie},payload:{...signed(),state:"a".repeat(43)}}]) {
      const r=await app.inject({method:"POST",url:"/auth/telegram",...request});
      expect(r.statusCode).toBe(403);expect(String(r.headers["set-cookie"])).not.toContain(SHOP_COOKIE_NAME);
    }
  });
  it("rejects stale and future signed authentication timestamps without a session", async () => {
    const intent=await start();
    for(const authDate of [Math.floor(Date.now()/1000)-901,Math.floor(Date.now()/1000)+90]) {
      const r=await app.inject({method:"POST",url:"/auth/telegram",headers:{cookie:intent.cookie},payload:{...signed(881100,authDate),state:intent.state}});
      expect(r.statusCode).toBe(403);expect(String(r.headers["set-cookie"])).not.toContain(SHOP_COOKIE_NAME);
    }
  });
  it("serves the callback bridge without redirecting away the browser fragment", async () => { const r=await app.inject({url:"/auth/telegram?next=%2Faccount"}); expect(r.statusCode).toBe(200); expect(r.headers["content-type"]).toContain("text/html"); });
  it("rejects login CSRF even with valid Telegram HMAC", async () => { const r=await app.inject({method:"POST",url:"/auth/telegram",payload:{...signed(),state:"attacker"}}); expect(r.statusCode).toBe(403); expect(String(r.headers["set-cookie"])).not.toContain(SHOP_COOKIE_NAME); });
  it("binds POST to browser state, establishes a session, and rejects replay with fresh intent", async () => {
    const intent=await start(); expect(intent.state).toBeTruthy(); const data=signed();
    const r=await app.inject({method:"POST",url:"/auth/telegram",headers:{cookie:intent.cookie},payload:{...data,state:intent.state,next:"/account"}});
    expect(r.statusCode).toBe(200); expect(r.json()).toEqual({redirect:"/account"}); expect(String(r.headers["set-cookie"])).toContain(SHOP_COOKIE_NAME);
    const fresh=await start(); const replay=await app.inject({method:"POST",url:"/auth/telegram",headers:{cookie:fresh.cookie},payload:{...data,state:fresh.state,next:"/account"}}); expect(replay.statusCode).toBe(403);
  });
  it("uses the destination bound at initiation, never a substituted callback next", async () => {
    const intent = await start();
    const r = await app.inject({method:"POST",url:"/auth/telegram",headers:{cookie:intent.cookie},payload:{...signed(881101),state:intent.state,next:"//evil.invalid"}});
    expect(r.statusCode).toBe(403); // unknown Telegram stays lookup-only
    await prisma.user.create({data:{telegramId:881102n,referralCode:"TGNEXT"}});
    const fresh = await start();
    const ok = await app.inject({method:"POST",url:"/auth/telegram",headers:{cookie:fresh.cookie},payload:{...signed(881102),state:fresh.state,next:"//evil.invalid"}});
    expect(ok.json()).toEqual({redirect:"/account"});
  });
  it("only consumes a browser intent once under concurrent callbacks", async () => {
    await prisma.user.create({data:{telegramId:881103n,referralCode:"TGRACE"}});
    const i=await start(); const request = {method:"POST" as const,url:"/auth/telegram",headers:{cookie:i.cookie},payload:{...signed(881103),state:i.state}};
    const results = await Promise.all([app.inject(request),app.inject(request)]);
    expect(results.map(r=>r.statusCode).sort()).toEqual([200,403]);
  });
  it("rejects expired intents without creating a session", async () => {
    const i=await start(); const key = "telegram_auth_intent:" + createHash("sha256").update(i.state!).digest("hex");
    await prisma.setting.update({where:{key},data:{value:JSON.stringify({purpose:"login",next:"/account",expires:Date.now()-1})}});
    const r=await app.inject({method:"POST",url:"/auth/telegram",headers:{cookie:i.cookie},payload:{...signed(),state:i.state}});
    expect(r.statusCode).toBe(403); expect(String(r.headers["set-cookie"])).not.toContain(SHOP_COOKIE_NAME);
  });
  it("rejects cross-origin POST and altered profile fields before session creation", async () => { const i=await start(); for(const headers of [{cookie:i.cookie,origin:"https://evil.invalid"},{cookie:i.cookie}]) { const r=await app.inject({method:"POST",url:"/auth/telegram",headers,payload:{...signed(),first_name:"Altered",state:i.state}}); expect(r.statusCode).toBe(403); } });
});
