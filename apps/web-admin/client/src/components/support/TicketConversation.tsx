import type { ReactNode } from "react";
import { Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** One entry of the conversation, already resolved to display strings by the page. */
export interface ConversationMessage {
  key: string;
  /** "Customer", the replying admin's name, or "Admin" when it can't be resolved. */
  sender: string;
  fromAdmin: boolean;
  internal: boolean;
  /** Short time ("01:32", "Oct 7, 22:41"); the full date-time goes in `timeTitle`. */
  time: string;
  timeTitle: string;
  content: string;
  photoIds: string[];
}

interface TicketConversationProps {
  messages: ConversationMessage[];
  onPreviewPhoto: (fileId: string) => void;
  /** The reply form, rendered directly under the newest message. Null when the
   *  ticket can't be replied to; `closedNote` explains why. */
  composer: ReactNode;
  closedNote?: ReactNode;
}

/**
 * The ticket's thread — the customer's original complaint first, then every
 * reply and internal note — with the reply form right under it, so an admin
 * reads and answers in one place.
 */
export function TicketConversation({ messages, onPreviewPhoto, composer, closedNote }: TicketConversationProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Conversation</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ol className="flex flex-col gap-3">
          {messages.map((m) => (
            <li
              key={m.key}
              data-testid="ticket-message"
              // Internal notes: dashed outline, no fill, and an explicit badge,
              // so they can't be mistaken for something the customer saw.
              // Customer-visible messages differ only by a light tint.
              className={cn(
                "min-w-0 rounded-lg px-3 py-2",
                m.internal
                  ? "border border-dashed border-ink-faint bg-paper"
                  : m.fromAdmin
                    ? "bg-pine-tint"
                    : "bg-sand",
              )}
            >
              <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-soft">
                {m.internal && (
                  <Badge variant="secondary" className="gap-1">
                    <Lock className="h-3 w-3" aria-hidden="true" />
                    Internal note
                  </Badge>
                )}
                <span>
                  <span className="font-medium text-ink">{m.sender}</span>
                  {" · "}
                  <span title={m.timeTitle}>{m.time}</span>
                </span>
              </div>
              {/* pre-wrap keeps the customer's line breaks; break-words stops a
                  pasted URL or token from overflowing the bubble. */}
              <div className="text-sm whitespace-pre-wrap break-words text-ink">{m.content}</div>
              {m.photoIds.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {m.photoIds.map((fileId) => (
                    <button
                      key={fileId}
                      type="button"
                      onClick={() => onPreviewPhoto(fileId)}
                      className="overflow-hidden rounded-lg border border-line focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      aria-label="View attachment"
                    >
                      <img src={`/api/support/photo/${fileId}`} alt="Attachment" className="h-16 w-16 object-cover" />
                    </button>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ol>
        {composer && <div className="border-t border-line pt-3">{composer}</div>}
        {!composer && closedNote && (
          <p className="border-t border-line pt-3 text-sm text-ink-soft">{closedNote}</p>
        )}
      </CardContent>
    </Card>
  );
}
