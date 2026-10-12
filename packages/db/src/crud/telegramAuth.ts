import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./_types";
const PREFIX = "telegram_auth_intent:";
const REPLAY = "telegram_auth_used:";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const TTL_MS = 15 * 60_000;
export async function createTelegramAuthIntent(db: Db, purpose: "login" | "link", next: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.setting.deleteMany({ where: { OR: [{key:{startsWith:PREFIX}}, {key:{startsWith:REPLAY}}], updatedAt: {lt:new Date(Date.now() - TTL_MS - 60_000)} } });
  await db.setting.create({data:{key:PREFIX + digest(token),value:JSON.stringify({purpose,next,expires:Date.now()+TTL_MS})}});
  return token;
}
/** Atomic one-use intent and replay record; only hashes persist, never auth payloads. */
export async function consumeTelegramAuthIntent(db: Db, token: string, purpose: "login" | "link", authHash: string): Promise<{next:string} | null> {
  const key = PREFIX + digest(token);
  const intent = await db.setting.findUnique({where:{key}});
  if (!intent) return null;
  const value = JSON.parse(intent.value) as {purpose:string;next:string;expires:number};
  if(value.purpose !== purpose || value.expires <= Date.now()) return null;
  if((await db.setting.deleteMany({where:{key,value:intent.value}})).count !== 1) return null;
  const inserted = await db.setting.createMany({data:{key:REPLAY + digest(authHash),value:"used"},skipDuplicates:true});
  return inserted.count === 1 ? {next:value.next} : null;
}
