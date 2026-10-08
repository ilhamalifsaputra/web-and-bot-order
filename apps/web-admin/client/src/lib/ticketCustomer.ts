/** The `user` object on `GET /api/support/:ticketId`. */
export interface TicketCustomerUser {
  id: number;
  fullName: string | null;
  username: string | null;
  telegramId: string | null;
  loginUsername: string | null;
  email: string | null;
  guestEmail: string | null;
  isGuest: boolean;
}

export interface TicketCustomerIdentity {
  name: string;
  kind: "registered" | "guest" | "unavailable";
  identifiers: { label: string; value: string }[];
}

/** Display name + secondary identifiers for a ticket's customer. */
export function describeTicketCustomer(user: TicketCustomerUser | null): TicketCustomerIdentity {
  if (!user) return { name: "Customer unavailable", kind: "unavailable", identifiers: [] };
  if (user.isGuest) {
    return {
      name: "Guest customer",
      kind: "guest",
      identifiers: user.guestEmail ? [{ label: "Email", value: user.guestEmail }] : [],
    };
  }
  const name =
    user.fullName || (user.username ? `@${user.username}` : null) || user.loginUsername || user.email || "Customer";
  const identifiers: { label: string; value: string }[] = [];
  if (user.email) identifiers.push({ label: "Email", value: user.email });
  if (user.telegramId) identifiers.push({ label: "Telegram ID", value: user.telegramId });
  return { name, kind: "registered", identifiers };
}
