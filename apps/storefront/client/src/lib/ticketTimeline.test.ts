import { describe, it, expect } from "vitest";
import { buildTicketTimeline } from "./ticketTimeline";
import type { TicketMessage } from "../api/types";

const baseTicket = {
  message: "It broke",
  created_at_display: "2026-07-01 09:00",
  admin_reply: null as string | null,
  replied_at_display: null as string | null,
  closed_at_display: null as string | null,
  attachments: [] as string[],
};

describe("buildTicketTimeline", () => {
  it("starts with a Created system event and the ticket's own message", () => {
    const entries = buildTicketTimeline(baseTicket, []);
    expect(entries[0]).toMatchObject({ kind: "system", key: "created" });
    expect(entries[1]).toMatchObject({ kind: "message", from_user: true, content: "It broke" });
  });

  it("sorts messages, legacy admin_reply, and the closed event chronologically", () => {
    const messages: TicketMessage[] = [
      { from_user: false, content: "reply 1", created_at_display: "2026-07-01 09:05", attachments: [] },
      { from_user: true, content: "follow up", created_at_display: "2026-07-01 09:10", attachments: [] },
    ];
    const entries = buildTicketTimeline(
      {
        ...baseTicket,
        admin_reply: "legacy reply",
        replied_at_display: "2026-07-01 09:02",
        closed_at_display: "2026-07-01 09:20",
      },
      messages,
    );
    const order = entries.map((e) => (e.kind === "system" ? `system:${e.key}` : e.kind === "message" ? e.content : ""));
    expect(order).toEqual([
      "system:created", // 09:00
      "It broke", // 09:00
      "legacy reply", // 09:02
      "reply 1", // 09:05
      "follow up", // 09:10
      "system:closed", // 09:20
    ]);
  });

  it("omits the legacy admin_reply entry when null, and the closed event when not closed", () => {
    const entries = buildTicketTimeline(baseTicket, []);
    expect(entries.some((e) => e.kind === "message" && e.content === "legacy reply")).toBe(false);
    expect(entries.some((e) => e.kind === "system" && e.key === "closed")).toBe(false);
  });

  it("carries attachments through on both the ticket's own message and thread messages", () => {
    const entries = buildTicketTimeline(
      { ...baseTicket, attachments: ["/uploads/tickets/a.png"] },
      [{ from_user: true, content: "more evidence", created_at_display: "2026-07-01 09:05", attachments: ["/uploads/tickets/b.png"] }],
    );
    const own = entries.find((e) => e.kind === "message" && e.content === "It broke");
    const thread = entries.find((e) => e.kind === "message" && e.content === "more evidence");
    expect(own).toMatchObject({ attachments: ["/uploads/tickets/a.png"] });
    expect(thread).toMatchObject({ attachments: ["/uploads/tickets/b.png"] });
  });
});
