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
  // The recipient address is deliberately NOT in the message string: this is
  // the one function every outgoing email passes through, so interpolating
  // `args.to` here wrote a customer's address into the logs on every send —
  // password resets, and now a guest's order-code mail for every guest order.
  // Callers take care not to leak the address (the guest-checkout path keeps
  // it out of URLs and out of its own log lines for exactly this reason), and
  // that care is worth nothing if this layer logs it anyway. Callers are also
  // expected to keep other secrets — like a guest's order code, half of the
  // /track credential — out of the subject for the same reason: whatever's in
  // the subject ends up here. What's left (shop name, mail kind) is what an
  // operator reading these lines actually needs.
  logger.info(`Sent an email with subject "${args.subject}"`);
}

/** Checks the SMTP connection/auth without sending an email — backs the
 * Settings page's "Test Connection" button. */
export async function verifySmtp(creds: SmtpCreds): Promise<boolean> {
  await transport(creds).verify();
  return true;
}
