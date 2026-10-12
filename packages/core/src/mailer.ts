import nodemailer from "nodemailer";
import { logger } from "./logger";

export interface SmtpCreds {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}
export interface MailAcceptance { messageId: string | null; acceptedAt: string }
export const EMAIL_RECIPIENT_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/** Validate transport evidence at consumers too, including alternate transport adapters. */
export function requireMailAcceptance(value: unknown): MailAcceptance {
  const evidence = value && typeof value === "object" ? value as Partial<MailAcceptance> : null;
  if (!evidence || typeof evidence.acceptedAt !== "string" || !Number.isFinite(Date.parse(evidence.acceptedAt))
    || !(evidence.messageId === null || typeof evidence.messageId === "string" && evidence.messageId.length <= 256 && !/[\r\n\u0000]/.test(evidence.messageId))) {
    throw Object.assign(new Error("Mail transport acceptance was not confirmed"), { code: "SMTP_ACCEPTANCE_UNCONFIRMED" });
  }
  return {messageId:evidence.messageId,acceptedAt:new Date(evidence.acceptedAt).toISOString()};
}

function transport(creds: SmtpCreds) {
  return nodemailer.createTransport({
    host: creds.host, port: creds.port, secure: creds.secure,
    auth: creds.user ? { user: creds.user, pass: creds.pass } : undefined,
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
  });
}

/** A resolved promise proves recipient acceptance by SMTP, never inbox placement. */
export async function sendMail(creds: SmtpCreds, args: { to: string; subject: string; text: string; html?: string }): Promise<MailAcceptance> {
  if (!EMAIL_RECIPIENT_RE.test(args.to)) throw Object.assign(new Error("Invalid email recipient"), {code:"INVALID_RECIPIENT"});
  const result = await transport(creds).sendMail({from:creds.from,to:args.to,subject:args.subject,text:args.text,html:args.html});
  const accepted = Array.isArray(result?.accepted) && result.accepted.some(value => typeof value === "string" && value.toLowerCase() === args.to.toLowerCase());
  if (!accepted) throw Object.assign(new Error("Mail server did not accept the recipient"), {code:"RECIPIENT_REJECTED"});
  const evidence = {
    messageId: typeof result.messageId === "string" && result.messageId.length <= 256 && !/[\r\n\u0000]/.test(result.messageId) ? result.messageId : null,
    acceptedAt: new Date().toISOString(),
  };
  logger.info("An email was accepted by the mail server; inbox delivery has not been confirmed.");
  return evidence;
}

/** Safe categories only: SMTP error messages can contain addresses or credentials. */
export function safeMailFailure(error: unknown): { code: string; permanent: boolean; message: string } {
  const err = error && typeof error === "object" ? error as {code?:unknown;responseCode?:unknown} : {};
  if (err.code === "SMTP_ACCEPTANCE_UNCONFIRMED") return {code:"SMTP_ACCEPTANCE_UNCONFIRMED",permanent:false,message:"Mail server acceptance could not be confirmed. Check the transport configuration before retrying."};
  if (err.code === "EAUTH") return {code:"SMTP_AUTH",permanent:true,message:"SMTP authentication failed. Check the saved credentials."};
  if (err.code === "INVALID_RECIPIENT" || err.code === "RECIPIENT_REJECTED" || err.code === "EENVELOPE" && Number(err.responseCode) >= 500) return {code:"SMTP_RECIPIENT",permanent:true,message:"The mail server rejected the recipient."};
  if (["ETLS", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(String(err.code))) return {code:"SMTP_TLS",permanent:true,message:"SMTP TLS verification failed. Check the server certificate and settings."};
  if (Number(err.responseCode) >= 500) return {code:"SMTP_REJECTED",permanent:true,message:"The mail server rejected the message."};
  if (Number(err.responseCode) >= 400) return {code:"SMTP_TEMPORARY",permanent:false,message:"The mail server temporarily rejected the message. Retry later."};
  return {code:"SMTP_CONNECTION",permanent:false,message:"The mail server could not be reached or did not accept the request. Check the connection and retry."};
}

/** Checks connection/auth only; it does not send a message. */
export async function verifySmtp(creds: SmtpCreds): Promise<boolean> {
  await transport(creds).verify();
  return true;
}
