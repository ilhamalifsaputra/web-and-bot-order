import type { Db } from "./_types";
/** Atomic per-admin cooldown, shared across processes. No SMTP secrets or addresses persist. */
export async function claimSmtpTest(db: Db, adminId: number, now = new Date()): Promise<boolean> {
  const key = `smtp_test_cooldown:${adminId}`;
  const inserted = await db.setting.createMany({data:{key,value:now.toISOString()},skipDuplicates:true});
  if(inserted.count === 1) return true;
  const updated = await db.setting.updateMany({where:{key,updatedAt:{lt:new Date(now.getTime()-60_000)}},data:{value:now.toISOString(),updatedAt:now}});
  return updated.count === 1;
}
