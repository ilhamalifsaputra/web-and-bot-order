import { describe, it, expect, beforeEach, vi } from "vitest";
import nodemailer from "nodemailer";
import { sendMail, SmtpCreds } from "./mailer";
import { logger } from "./logger";

// Mock nodemailer
vi.mock("nodemailer");

describe("sendMail", () => {
  let mockSendMail: ReturnType<typeof vi.fn>;
  let mockVerify: ReturnType<typeof vi.fn>;
  let mockCreateTransport: ReturnType<typeof vi.fn>;
  const mockCreds: SmtpCreds = {
    host: "smtp.example.com",
    port: 587,
    secure: false,
    user: "user@example.com",
    pass: "password",
    from: "noreply@example.com",
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockSendMail = vi.fn().mockResolvedValue(undefined);
    mockVerify = vi.fn().mockResolvedValue(undefined);

    mockCreateTransport = vi.fn().mockReturnValue({
      sendMail: mockSendMail,
      verify: mockVerify,
    });

    (nodemailer.createTransport as any) = mockCreateTransport;

    // Spy on logger.info
    vi.spyOn(logger, "info").mockImplementation(() => {});
  });

  it("forwards html to the transport when html is provided", async () => {
    const args = {
      to: "recipient@example.com",
      subject: "Test Subject",
      text: "Plain text body",
      html: "<p>HTML body</p>",
    };

    await sendMail(mockCreds, args);

    expect(mockSendMail).toHaveBeenCalledWith({
      from: mockCreds.from,
      to: args.to,
      subject: args.subject,
      text: args.text,
      html: args.html,
    });
  });

  it("sends successfully without html when not provided", async () => {
    const args = {
      to: "recipient@example.com",
      subject: "Test Subject",
      text: "Plain text body",
    };

    await sendMail(mockCreds, args);

    expect(mockSendMail).toHaveBeenCalledWith({
      from: mockCreds.from,
      to: args.to,
      subject: args.subject,
      text: args.text,
    });
  });

  it("logs the subject in logger.info and never includes args.to", async () => {
    const args = {
      to: "recipient@example.com",
      subject: "Test Subject",
      text: "Plain text body",
      html: "<p>HTML body</p>",
    };

    await sendMail(mockCreds, args);

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(args.subject)
    );

    const loggerCalls = (logger.info as any).mock.calls;
    for (const call of loggerCalls) {
      const message = JSON.stringify(call);
      expect(message).not.toContain(args.to);
    }
  });

  it("logs the subject correctly when html is not provided", async () => {
    const args = {
      to: "recipient@example.com",
      subject: "No HTML Subject",
      text: "Plain text only",
    };

    await sendMail(mockCreds, args);

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(args.subject)
    );

    const loggerCalls = (logger.info as any).mock.calls;
    for (const call of loggerCalls) {
      const message = JSON.stringify(call);
      expect(message).not.toContain(args.to);
    }
  });
});
