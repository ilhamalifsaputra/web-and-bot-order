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

function transport(creds: SmtpCreds) {
  return nodemailer.createTransport({
    host: creds.host,
    port: creds.port,
    secure: creds.secure,
    auth: creds.user ? { user: creds.user, pass: creds.pass } : undefined,
  });
}

export async function sendMail(creds: SmtpCreds, args: { to: string; subject: string; text: string }): Promise<void> {
  await transport(creds).sendMail({
    from: creds.from,
    to: args.to,
    subject: args.subject,
    text: args.text,
  });
  logger.info(`Sent email to ${args.to} with subject "${args.subject}"`);
}

/** Checks the SMTP connection/auth without sending an email — backs the
 * Settings page's "Test Connection" button. */
export async function verifySmtp(creds: SmtpCreds): Promise<boolean> {
  await transport(creds).verify();
  return true;
}
