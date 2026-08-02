import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { apiPost } from "../../api/client";
import { describeError } from "../../lib/errorMessages";
import { Stars } from "../../components/shared/Stars";

export interface ReplyDialogReview {
  id: number;
  rating: number;
  comment: string | null;
  /** Existing admin reply, if any — present means this dialog is editing an
   *  existing reply rather than sending a first one. */
  adminReply: string | null;
}

interface ReplyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The review being replied to. Only read while `open` is true — callers
   *  (e.g. a row's DropdownMenuItem) typically set this together with
   *  `open`, but it may briefly linger `null`-less during the close
   *  animation, which is harmless since the dialog is no longer visible. */
  review: ReplyDialogReview | null;
}

/**
 * Controlled reply dialog — opened from a row's DropdownMenuItem (owned by
 * the assembling page, see ReviewsKpiRow.tsx's callback-prop precedent).
 * Posts to POST /api/reviews/:id/reply, which both creates a first reply and
 * overwrites an existing one (the backend flips the review's status to
 * REPLIED either way — see apps/web-admin/src/routes/api/reviews.ts).
 */
export function ReplyDialog({ open, onOpenChange, review }: ReplyDialogProps): JSX.Element {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const isEditing = review?.adminReply != null;

  // Re-seed the draft text whenever the dialog opens for a (possibly new)
  // review, rather than on every `review` identity change — the dialog stays
  // mounted across opens/closes (Radix Dialog default), so this must not
  // reset the admin's in-progress typing while the dialog is already open.
  useEffect(() => {
    if (open) setText(review?.adminReply ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, review?.id]);

  const sendReply = useMutation({
    mutationFn: (reply: string) => apiPost<{ ok: boolean }>(`/api/reviews/${review!.id}/reply`, { reply }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["reviews"] });
      toast.success(isEditing ? "Reply updated." : "Reply sent.");
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(describeError(e.message)),
  });

  function handleSend() {
    const trimmed = text.trim();
    if (!trimmed || !review) return;
    sendReply.mutate(trimmed);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{isEditing ? "Update Reply" : "Reply to Review"}</DialogTitle>
        </DialogHeader>

        {review && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Stars rating={review.rating} />
              <span className="text-xs text-ink-soft">{review.rating}/5</span>
            </div>
            {review.comment && <p className="text-sm text-ink-soft">{review.comment}</p>}
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Write a reply…"
              rows={4}
              autoFocus
            />
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSend} disabled={!text.trim() || sendReply.isPending}>
            {sendReply.isPending ? "Saving…" : isEditing ? "Update Reply" : "Send Reply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
