import { describe, it, expect } from "vitest";
import {
  resolveOwnerEmailRecipient,
  type OwnerEmailEvent,
} from "./ownerEmail";
import type { Db } from "./_types";

/** In-memory Setting store as a Db stub (only `setting.findUnique` is used). */
function stubDb(values: Record<string, string>): Db {
  return {
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        values[where.key] != null ? { key: where.key, value: values[where.key] } : null,
    },
  } as unknown as Db;
}

const EVENT_TOGGLE_KEY: Record<OwnerEmailEvent, string> = {
  paid_order: "owner_email_on_paid_order",
  manual_queue: "owner_email_on_manual_queue",
  new_ticket: "owner_email_on_new_ticket",
  ticket_reply: "owner_email_on_ticket_reply",
};

/** Full config with every toggle on and a valid address, for one event. */
function fullyConfigured(event: OwnerEmailEvent, overrides: Record<string, string> = {}): Db {
  return stubDb({
    owner_email_enabled: "true",
    owner_email: "owner@example.com",
    [EVENT_TOGGLE_KEY[event]]: "true",
    ...overrides,
  });
}

describe("resolveOwnerEmailRecipient", () => {
  it("returns null when nothing is configured (missing toggles = off)", async () => {
    expect(await resolveOwnerEmailRecipient(stubDb({}), "paid_order")).toBeNull();
  });

  it("returns null when the master toggle is off, even if the per-event toggle and address are set", async () => {
    const db = fullyConfigured("paid_order", { owner_email_enabled: "false" });
    expect(await resolveOwnerEmailRecipient(db, "paid_order")).toBeNull();
  });

  it("returns null when the master toggle is missing (blank = off), even if everything else is set", async () => {
    const db = stubDb({ owner_email: "owner@example.com", owner_email_on_manual_queue: "true" });
    expect(await resolveOwnerEmailRecipient(db, "manual_queue")).toBeNull();
  });

  it("returns null when master is on but the specific event's toggle is off", async () => {
    const db = fullyConfigured("new_ticket", { owner_email_on_new_ticket: "false" });
    expect(await resolveOwnerEmailRecipient(db, "new_ticket")).toBeNull();
  });

  it("returns null when master is on but the specific event's toggle is missing", async () => {
    const db = stubDb({ owner_email_enabled: "true", owner_email: "owner@example.com" });
    expect(await resolveOwnerEmailRecipient(db, "ticket_reply")).toBeNull();
  });

  it("returns null when the address is blank", async () => {
    const db = fullyConfigured("paid_order", { owner_email: "   " });
    expect(await resolveOwnerEmailRecipient(db, "paid_order")).toBeNull();
  });

  it("returns null when the address setting is entirely missing", async () => {
    const db = stubDb({ owner_email_enabled: "true", owner_email_on_paid_order: "true" });
    expect(await resolveOwnerEmailRecipient(db, "paid_order")).toBeNull();
  });

  it("returns null when the address is malformed", async () => {
    const db = fullyConfigured("paid_order", { owner_email: "not-an-email" });
    expect(await resolveOwnerEmailRecipient(db, "paid_order")).toBeNull();
  });

  it("returns the trimmed address when everything is correctly configured", async () => {
    const db = fullyConfigured("paid_order");
    expect(await resolveOwnerEmailRecipient(db, "paid_order")).toBe("owner@example.com");
  });

  it("trims surrounding whitespace from the returned address", async () => {
    const db = fullyConfigured("manual_queue", { owner_email: "  owner@example.com  " });
    expect(await resolveOwnerEmailRecipient(db, "manual_queue")).toBe("owner@example.com");
  });

  it("parses the master and event toggles case-insensitively", async () => {
    const db = fullyConfigured("new_ticket", { owner_email_enabled: "TRUE", owner_email_on_new_ticket: "True" });
    expect(await resolveOwnerEmailRecipient(db, "new_ticket")).toBe("owner@example.com");
  });

  it("each event reads its own toggle independently: enabling new_ticket does not enable the other three", async () => {
    const db = fullyConfigured("new_ticket");
    expect(await resolveOwnerEmailRecipient(db, "new_ticket")).toBe("owner@example.com");
    expect(await resolveOwnerEmailRecipient(db, "paid_order")).toBeNull();
    expect(await resolveOwnerEmailRecipient(db, "manual_queue")).toBeNull();
    expect(await resolveOwnerEmailRecipient(db, "ticket_reply")).toBeNull();
  });

  it("each of the four events can be independently enabled while the others stay off", async () => {
    const db = stubDb({
      owner_email_enabled: "true",
      owner_email: "owner@example.com",
      owner_email_on_paid_order: "true",
      owner_email_on_manual_queue: "false",
      owner_email_on_new_ticket: "false",
      owner_email_on_ticket_reply: "false",
    });
    expect(await resolveOwnerEmailRecipient(db, "paid_order")).toBe("owner@example.com");
    expect(await resolveOwnerEmailRecipient(db, "manual_queue")).toBeNull();
    expect(await resolveOwnerEmailRecipient(db, "new_ticket")).toBeNull();
    expect(await resolveOwnerEmailRecipient(db, "ticket_reply")).toBeNull();
  });
});
