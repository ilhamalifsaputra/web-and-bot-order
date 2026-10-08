import { describe, it, expect } from "vitest";
import { buildTicketActivity, type TicketActivityRow } from "./ticketActivity";

const ctx = {
  ticketLabel: "#T-42",
  actorLabel: (r: TicketActivityRow) => (r.actorType === "CUSTOMER" ? "Customer" : `Admin ${r.adminId}`),
};

let n = 0;
function row(over: Partial<TicketActivityRow>): TicketActivityRow {
  n += 1;
  return {
    id: n,
    adminId: 1,
    actorType: "ADMIN",
    action: "ticket_reply",
    details: null,
    createdAt: "2026-10-01T10:00:00.000Z",
    createdAtShort: "10:00",
    createdAtDisplay: "2026-10-01 10:00",
    statusChange: null,
    ...over,
  };
}
const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 10, 0, s)).toISOString();

describe("buildTicketActivity", () => {
  it("returns oldest-first from newest-first input with time fields", () => {
    const a = row({ action: "ticket_create", actorType: "CUSTOMER", adminId: null, createdAt: at(0) });
    const b = row({ action: "ticket_reply", createdAt: at(60), createdAtShort: "10:01" });
    const out = buildTicketActivity([b, a], ctx);
    expect(out.map((e) => e.id)).toEqual([a.id, b.id]);
    expect(out[0]!).toMatchObject({ text: "Ticket created", time: "10:00", timeTitle: "2026-10-01 10:00" });
    expect(out[1]!.text).toBe("Admin 1 replied");
  });

  it("falls back to createdAtDisplay then empty string for time", () => {
    const x = row({ createdAtShort: null });
    const y = row({ createdAtShort: null, createdAtDisplay: null });
    expect(buildTicketActivity([x], ctx)[0]!.time).toBe("2026-10-01 10:00");
    expect(buildTicketActivity([y], ctx)[0]).toMatchObject({ time: "", timeTitle: "" });
  });

  it("maps action-keyed sentences", () => {
    const rows = [
      row({ action: "ticket_note", createdAt: at(0) }),
      row({ action: "ticket_resolve", createdAt: at(100) }),
      row({ action: "ticket_reopen", createdAt: at(200) }),
      row({ action: "ticket_close", createdAt: at(300) }),
    ].reverse();
    expect(buildTicketActivity(rows, ctx).map((e) => e.text)).toEqual([
      "Admin 1 added an internal note",
      "Resolved",
      "Reopened",
      "Closed",
    ]);
  });

  it("uses details for unknown actions with the ticket id replaced, case-insensitively", () => {
    const r = row({ action: "ticket_assign", details: "Assigned Ticket #42 to Rina" });
    expect(buildTicketActivity([r], ctx)[0]!.text).toBe("Assigned ticket #T-42 to Rina");
  });

  it("falls back to the action name when details is missing", () => {
    const r = row({ action: "ticket_weird", details: null });
    expect(buildTicketActivity([r], ctx)[0]!.text).toBe("ticket_weird");
  });

  it("folds a following status change within 10s by the same admin into the entry", () => {
    const reply = row({ action: "ticket_reply", createdAt: at(0) });
    const sc = row({ action: "ticket_status_change", createdAt: at(5), statusChange: { from: "OPEN", to: "REPLIED" } });
    const out = buildTicketActivity([sc, reply], ctx);
    expect(out).toHaveLength(1);
    expect(out[0]!).toMatchObject({ id: reply.id, statusTo: "Waiting for customer" });
  });

  it("folds a preceding status change within 10s into the entry", () => {
    const sc = row({ action: "ticket_status_change", createdAt: at(0), statusChange: { from: "OPEN", to: "RESOLVED" } });
    const resolve = row({ action: "ticket_resolve", createdAt: at(3) });
    const out = buildTicketActivity([resolve, sc], ctx);
    expect(out).toHaveLength(1);
    expect(out[0]!).toMatchObject({ id: resolve.id, text: "Resolved", statusTo: "Resolved" });
  });

  it("keeps the status change separate beyond 10s, for another admin, or with null adminId", () => {
    const reply = row({ action: "ticket_reply", createdAt: at(0) });
    const far = row({ action: "ticket_status_change", createdAt: at(11), statusChange: { from: "OPEN", to: "CLOSED" } });
    const other = row({ action: "ticket_status_change", adminId: 2, createdAt: at(2), statusChange: { from: "OPEN", to: "CLOSED" } });
    const sys = row({ action: "ticket_status_change", adminId: null, createdAt: at(1), statusChange: { from: "OPEN", to: "CLOSED" } });
    const out = buildTicketActivity([far, other, sys, reply], ctx);
    expect(out).toHaveLength(4);
    expect(out.filter((e) => e.text === "Status → Closed")).toHaveLength(3);
    expect(out.find((e) => e.id === reply.id)?.statusTo).toBeUndefined();
  });

  it("does not fold into a non-mergeable action", () => {
    const note = row({ action: "ticket_note", createdAt: at(0) });
    const sc = row({ action: "ticket_status_change", createdAt: at(2), statusChange: { from: "OPEN", to: "RESOLVED" } });
    expect(buildTicketActivity([sc, note], ctx)).toHaveLength(2);
  });

  it("does not fold one status change into two entries", () => {
    const r1 = row({ action: "ticket_reply", createdAt: at(0) });
    const sc = row({ action: "ticket_status_change", createdAt: at(4), statusChange: { from: "OPEN", to: "REPLIED" } });
    const r2 = row({ action: "ticket_reply", createdAt: at(8) });
    const out = buildTicketActivity([r2, sc, r1], ctx);
    expect(out).toHaveLength(2);
    expect(out.filter((e) => e.statusTo).length).toBe(1);
  });

  it("shows a standalone status change with no statusChange payload gracefully", () => {
    const sc = row({ action: "ticket_status_change", details: "changed", statusChange: null });
    expect(buildTicketActivity([sc], ctx)[0]!.text).toBe("changed");
  });
});
