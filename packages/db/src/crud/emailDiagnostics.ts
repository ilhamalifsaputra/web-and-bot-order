import type { Db } from "./_types";
import { EMAIL_RECIPIENT_RE } from "@app/core/mailer";
interface EmailEvidenceRow {event:string;status:string;payloadJson:string;fulfillmentProvider:string|null}
/** Legacy shortcut candidates are advisory; old SENT alone cannot prove delivery or failure. */
export function classifyEmailDelivery(row: EmailEvidenceRow) {
  let payload: Record<string,unknown> = {};
  try { const value: unknown=JSON.parse(row.payloadJson); if(value && typeof value === "object" && !Array.isArray(value)) payload=value as Record<string,unknown>; } catch { /* report invalid payload without exposing it */ }
  const evidence=payload.delivery as {acceptedAt?:unknown} | null | undefined;
  const accepted=row.status === "SENT" && typeof evidence?.acceptedAt === "string" && Number.isFinite(Date.parse(evidence.acceptedAt));
  const outcome=accepted ? "transport_accepted" : row.status === "SENT" ? "sent_without_evidence" : "not_sent";
  const legacySuppressionCandidate=outcome === "sent_without_evidence" && (row.event === "OWNER_EMAIL_WALLET_TOPUP" || row.event === "OWNER_EMAIL_ORDER_PAID" && row.fulfillmentProvider !== null && row.fulfillmentProvider !== "MANUAL" || row.event === "OWNER_EMAIL_MANUAL_ORDER_QUEUED" && row.fulfillmentProvider === "DIGIFLAZZ");
  return {outcome,legacySuppressionCandidate,hasRecipient:typeof payload.to === "string" && EMAIL_RECIPIENT_RE.test(payload.to)};
}
/** Read-only, bounded report: aggregates only, no addresses, order codes, tokens, or message bodies. */
export async function emailDeliveryDiagnostics(db: Db, limit = 1000) {
  const rows=await db.notificationOutbox.findMany({where:{channel:"EMAIL"},orderBy:{id:"desc"},take:Math.min(10_000,Math.max(1,Math.floor(limit))),select:{event:true,status:true,payloadJson:true,order:{select:{fulfillmentProvider:true}}}});
  const counts={inspected:rows.length,transportAccepted:0,sentWithoutEvidence:0,legacySuppressionCandidates:0,noValidRecipient:0,notSent:0};
  for(const row of rows) {const item=classifyEmailDelivery({...row,fulfillmentProvider:row.order?.fulfillmentProvider ?? null});if(item.outcome === "transport_accepted") counts.transportAccepted++;else if(item.outcome === "sent_without_evidence") counts.sentWithoutEvidence++;else counts.notSent++;if(item.legacySuppressionCandidate) counts.legacySuppressionCandidates++;if(!item.hasRecipient) counts.noValidRecipient++;}
  const orders=await db.order.findMany({where:{kind:"PRODUCT"},orderBy:{id:"desc"},take:8,select:{user:{select:{isGuest:true,email:true,guestEmail:true}}}});
  const recentOrdersWithoutEmail=orders.filter(({user})=> !EMAIL_RECIPIENT_RE.test((user.isGuest ? user.guestEmail : user.email) ?? "")).length;
  return {...counts,recentOrdersInspected:orders.length,recentOrdersWithoutEmail,readOnly:true as const,inboxDeliveryConfirmed:false as const};
}
