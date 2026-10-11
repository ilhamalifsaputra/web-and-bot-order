import { describe, it, expect } from "vitest";
import { buildTicketTimeline } from "./ticketTimeline";
import type { TicketMessage } from "../api/types";

const baseTicket = { id: 1,
  message: "It broke",
  created_at_display: "2026-07-01 09:00",
  admin_reply: null as string | null,
  replied_at_display: null as string | null,
  closed_at_display: null as string | null,
  attachments: [] as string[],
};

describe("buildTicketTimeline", () => {
  it("keeps distinct identities for duplicate messages across refetch, sorting, and legacy events", () => {
    const message = { from_user: false, content: "same", created_at_display: "2026-07-01 09:05", attachments: [] };
    const ticket = { ...baseTicket, admin_reply: "same", replied_at_display: message.created_at_display, closed_at_display: message.created_at_display };
    const first = buildTicketTimeline(ticket, [{ ...message, id: 101 }, { ...message, id: 102 }]);
    const second = buildTicketTimeline(ticket, [
      { ...message, id: 103, created_at_display: "2026-07-01 09:01" },
      { ...message, id: 102 }, { ...message, id: 101 },
    ]);
    expect(new Set(first.map(entry => entry.id)).size).toBe(first.length);
    expect(new Set(second.map(entry => entry.id)).size).toBe(second.length);
    for (const entry of first) expect(second.find(next => next.id === entry.id)).toEqual(entry);
    expect(second.filter(entry => entry.id.startsWith("message:")).map(entry => entry.id)).toEqual(["message:103", "message:102", "message:101"]);
  });

  it("starts with a Created system event and the ticket's own message", () => {
    const entries = buildTicketTimeline(baseTicket, []);
    expect(entries[0]).toMatchObject({ kind: "system", key: "created" });
    expect(entries[1]).toMatchObject({ kind: "message", from_user: true, content: "It broke" });
  });

  it("sorts messages, legacy admin_reply, and the closed event chronologically", () => {
    const messages: TicketMessage[] = [
      { id: 2, from_user: false, content: "reply 1", created_at_display: "2026-07-01 09:05", attachments: [] },
      { id: 3, from_user: true, content: "follow up", created_at_display: "2026-07-01 09:10", attachments: [] },
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
      [{ id: 4, from_user: true, content: "more evidence", created_at_display: "2026-07-01 09:05", attachments: ["/uploads/tickets/b.png"] }],
    );
    const own = entries.find((e) => e.kind === "message" && e.content === "It broke");
    const thread = entries.find((e) => e.kind === "message" && e.content === "more evidence");
    expect(own).toMatchObject({ attachments: ["/uploads/tickets/a.png"] });
    expect(thread).toMatchObject({ attachments: ["/uploads/tickets/b.png"] });
  });
});
