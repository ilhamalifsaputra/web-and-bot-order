import type { Ref } from "react";
import { humanError } from "../../lib/errors";
import Alert from "../ui/Alert";

/** Guest email errors stay beside the email field; other checkout failures use the banner. */
export default function CheckoutErrorBanner({ error, isGuest, anchorRef }: { error: unknown; isGuest: boolean; anchorRef?: Ref<HTMLDivElement> }) {
  const key = error instanceof Error ? error.message : null;
  if (!key || (isGuest && key === "web.guest_email_invalid")) return null;
  return <div ref={anchorRef}><Alert variant="banner" tone="error">{humanError(error)}</Alert></div>;
}
