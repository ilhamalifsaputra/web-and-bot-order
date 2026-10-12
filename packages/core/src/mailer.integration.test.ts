import { createServer, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { safeMailFailure, sendMail, verifySmtp, type SmtpCreds } from "./mailer";

/** An isolated SMTP receiver: no external network, authentication or real addresses. */
async function withSmtpReceiver(
  mode: "accept" | "reject_recipient" | "temporary_data",
  run: (creds: SmtpCreds, received: { commands: string[]; messages: string[] }) => Promise<void>,
) {
  const sockets = new Set<Socket>();
  const received = { commands: [] as string[], messages: [] as string[] };
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setTimeout(10_000, () => socket.destroy());
    socket.write("220 localhost integration receiver\r\n");
    let buffer = "", data: string[] | null = null;
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let boundary: number;
      while ((boundary = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (data !== null) {
          if (line === ".") {
            received.messages.push(data.join("\r\n"));
            data = null;
            socket.write(mode === "temporary_data" ? "450 Temporary test rejection\r\n" : "250 Message accepted\r\n");
          } else data.push(line.replace(/^\.\./, "."));
          continue;
        }
        received.commands.push(line);
        if (/^(EHLO|HELO)\b/i.test(line)) socket.write("250-localhost\r\n250 8BITMIME\r\n");
        else if (/^RCPT TO:/i.test(line) && mode === "reject_recipient") socket.write("550 Recipient rejected\r\n");
        else if (line === "DATA") { data = []; socket.write("354 End with a dot\r\n"); }
        else if (line === "QUIT") socket.end("221 Bye\r\n");
        else socket.write("250 OK\r\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("SMTP test receiver did not bind a local TCP port.");
  try {
    await run({ host: "127.0.0.1", port: address.port, secure: false, user: "", pass: "", from: "sender@example.invalid" }, received);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

const message = { to: "recipient@example.invalid", subject: "Local SMTP integration", text: "Transport integration body.", html: "<p>Transport integration body.</p>" };

describe("real SMTP transport on isolated loopback", () => {
  it("verifies connectivity without sending, then sends envelope and MIME data before returning acceptance", async () => {
    await withSmtpReceiver("accept", async (creds, received) => {
      expect(await verifySmtp(creds)).toBe(true);
      expect(received.messages).toHaveLength(0);
      expect(received.commands).not.toContain("DATA");
      const evidence = await sendMail(creds, message);
      expect(received.commands.filter((line) => /^MAIL FROM:/i.test(line))).toHaveLength(1);
      expect(received.commands.filter((line) => /^RCPT TO:/i.test(line))).toEqual(["RCPT TO:<recipient@example.invalid>"]);
      expect(received.messages).toHaveLength(1);
      expect(received.messages[0]).toContain("Subject: Local SMTP integration");
      expect(received.messages[0]).toContain("Transport integration body.");
      expect(evidence.messageId).toEqual(expect.any(String));
      expect(Number.isFinite(Date.parse(evidence.acceptedAt))).toBe(true);
    });
  });
  it("rejects a real SMTP recipient refusal before transmitting message data", async () => {
    await withSmtpReceiver("reject_recipient", async (creds, received) => {
      const error = await sendMail(creds, message).then(() => null, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(Error);
      expect(safeMailFailure(error)).toMatchObject({ code: "SMTP_RECIPIENT", permanent: true });
      expect(received.messages).toHaveLength(0);
    });
  });
  it("does not return acceptance when SMTP temporarily refuses the transmitted message", async () => {
    await withSmtpReceiver("temporary_data", async (creds, received) => {
      const error = await sendMail(creds, message).then(() => null, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(Error);
      expect(safeMailFailure(error)).toMatchObject({ code: "SMTP_TEMPORARY", permanent: false });
      expect(received.messages).toHaveLength(1);
    });
  });
});
