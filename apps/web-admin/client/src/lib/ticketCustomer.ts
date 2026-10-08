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

/**
 * Display name + secondary identifiers for a ticket's customer. Email is used
 * only as the last-resort name for a registered user with no other name (same
 * as /api/search); a guest has no other identity, so their email stays listed.
 */
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
  // Privacy (backend audit H-4): a registered customer's email is never listed
  // as an identifier; it only surfaces above as the last-resort name fallback.
  if (user.telegramId) identifiers.push({ label: "Telegram ID", value: user.telegramId });
  return { name, kind: "registered", identifiers };
}
