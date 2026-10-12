import { describe, it, expect, beforeEach, vi } from "vitest";
import nodemailer from "nodemailer";
import { sendMail, requireMailAcceptance, safeMailFailure, SmtpCreds } from "./mailer";
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

    mockSendMail = vi.fn().mockResolvedValue({accepted:["recipient@example.com"], rejected:[], messageId:"<mail-1@test.invalid>"});
    mockVerify = vi.fn().mockResolvedValue(undefined);

    mockCreateTransport = vi.fn().mockReturnValue({
      sendMail: mockSendMail,
      verify: mockVerify,
    });

    (nodemailer.createTransport as any) = mockCreateTransport;

    // Spy on logger.info
    vi.spyOn(logger, "info").mockImplementation(() => {});
  });

  it("requires explicit SMTP acceptance for the requested recipient", async () => {
    for (const result of [undefined, {accepted:[],rejected:["recipient@example.com"]}, {accepted:["other@example.com"]}]) {
      mockSendMail.mockResolvedValueOnce(result);
      await expect(sendMail(mockCreds,{to:"recipient@example.com",subject:"Test",text:"Test"})).rejects.toThrow();
    }
  });
  it("returns provider acceptance evidence without implying inbox delivery", async () => {
    const result = await sendMail(mockCreds,{to:"recipient@example.com",subject:"Test",text:"Test"});
    expect(result).toEqual({messageId:"<mail-1@test.invalid>",acceptedAt:expect.any(String)});
  });
  it.each([undefined, {}, {acceptedAt:"invalid",messageId:null}, {acceptedAt:"2026-10-12T00:00:00.000Z"}, {acceptedAt:"2026-10-12T00:00:00.000Z",messageId:"bad\r\nsecret"}])("rejects incomplete transport evidence %#", value => {
    expect(() => requireMailAcceptance(value)).toThrow("acceptance was not confirmed");
  });
  it("categorizes an unconfirmed acceptance safely for retry", () => {
    expect(safeMailFailure({code:"SMTP_ACCEPTANCE_UNCONFIRMED",message:"secret"})).toMatchObject({code:"SMTP_ACCEPTANCE_UNCONFIRMED",permanent:false});
  });
  it("refuses address lists and header injection before contacting SMTP", async () => {
    for(const to of ["one@example.com,two@example.com", "bad\r\nBcc:other@example.com", ""]) {
      await expect(sendMail(mockCreds,{to,subject:"Test",text:"Test"})).rejects.toThrow();
    }
    expect(mockSendMail).not.toHaveBeenCalled();
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

  it("never logs subject or recipient", async () => {
    const args = {
      to: "recipient@example.com",
      subject: "Test Subject",
      text: "Plain text body",
      html: "<p>HTML body</p>",
    };

    await sendMail(mockCreds, args);

    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain(args.subject);

    const loggerCalls = (logger.info as any).mock.calls;
    for (const call of loggerCalls) {
      const message = JSON.stringify(call);
      expect(message).not.toContain(args.to);
    }
  });

  it("keeps plain text subjects out of logs", async () => {
    const args = {
      to: "recipient@example.com",
      subject: "No HTML Subject",
      text: "Plain text only",
    };

    await sendMail(mockCreds, args);

    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain(args.subject);

    const loggerCalls = (logger.info as any).mock.calls;
    for (const call of loggerCalls) {
      const message = JSON.stringify(call);
      expect(message).not.toContain(args.to);
    }
  });
});
