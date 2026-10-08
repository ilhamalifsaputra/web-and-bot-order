import { describe, it, expect } from "vitest";
import { describeTicketCustomer, type TicketCustomerUser } from "./ticketCustomer";

const base: TicketCustomerUser = {
  id: 1,
  fullName: null,
  username: null,
  telegramId: null,
  loginUsername: null,
  email: null,
  guestEmail: null,
  isGuest: false,
};

describe("describeTicketCustomer", () => {
  it("prefers fullName and lists only the Telegram ID identifier (never the email)", () => {
    expect(
      describeTicketCustomer({ ...base, fullName: "Rina", username: "rina", email: "r@x.id", telegramId: "123" }),
    ).toEqual({
      name: "Rina",
      kind: "registered",
      identifiers: [{ label: "Telegram ID", value: "123" }],
    });
  });

  it("falls back fullName -> @username -> loginUsername -> email", () => {
    expect(describeTicketCustomer({ ...base, username: "rina" }).name).toBe("@rina");
    expect(describeTicketCustomer({ ...base, loginUsername: "rina_l" }).name).toBe("rina_l");
    expect(describeTicketCustomer({ ...base, email: "r@x.id" }).name).toBe("r@x.id");
  });

  it("does not list email as an identifier when it is the fallback name", () => {
    expect(describeTicketCustomer({ ...base, email: "r@x.id" })).toEqual({
      name: "r@x.id",
      kind: "registered",
      identifiers: [],
    });
  });

  it("omits identifiers that are absent", () => {
    expect(describeTicketCustomer({ ...base, fullName: "Rina" }).identifiers).toEqual([]);
  });

  it("describes a guest with their guest email", () => {
    expect(describeTicketCustomer({ ...base, isGuest: true, guestEmail: "g@x.id" })).toEqual({
      name: "Guest customer",
      kind: "guest",
      identifiers: [{ label: "Email", value: "g@x.id" }],
    });
  });

  it("describes a missing user as unavailable", () => {
    expect(describeTicketCustomer(null)).toEqual({ name: "Customer unavailable", kind: "unavailable", identifiers: [] });
  });
});
