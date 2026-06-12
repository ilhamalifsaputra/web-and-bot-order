import nodemailer, { type Transporter } from "nodemailer";
import { config, isSmtpEnabled } from "./config";
import { logger } from "./logger";

let transporter: Transporter | null = null;

function transport(): Transporter {
  if (!isSmtpEnabled()) throw new Error("SMTP is not configured");
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
    });
  }
  return transporter;
}

export async function sendMail(args: { to: string; subject: string; text: string }): Promise<void> {
  await transport().sendMail({
    from: config.SMTP_FROM,
    to: args.to,
    subject: args.subject,
    text: args.text,
  });
  logger.info(`Sent mail to=${args.to} subject="${args.subject}"`);
}
