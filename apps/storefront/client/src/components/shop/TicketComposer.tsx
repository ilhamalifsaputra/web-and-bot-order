/** Reply composer for the ticket thread — textarea + attachments + char
 * counter + Ctrl/Cmd+Enter shortcut + debounced draft autosave. Fully
 * controlled: the parent owns `message`/`files` and passes `onSubmit`; this
 * component only *saves* drafts on change (see lib/ticketDraft.ts) — loading
 * the initial draft and clearing it on success are the parent's job, since
 * those need to happen exactly once at mount / on mutation success. */
import { useEffect, useRef, type ReactNode, type KeyboardEvent } from "react";
import { Send } from "lucide-react";
import { t } from "../../lib/i18n";
import { saveTicketDraft } from "../../lib/ticketDraft";
import Button from "../ui/Button";
import Textarea from "../ui/Textarea";
import AttachmentPicker from "./AttachmentPicker";
import ProgressBar from "./ProgressBar";
import Spinner from "./Spinner";

const MAX_MESSAGE_LENGTH = 2000;
const DRAFT_SAVE_DEBOUNCE_MS = 500;

export interface TicketComposerProps {
  ticketId: number;
  message: string;
  onMessageChange: (value: string) => void;
  files: File[];
  onFilesChange: (files: File[]) => void;
  onSubmit: () => void;
  pending: boolean;
  uploadProgress: number;
  uploadSlot?: ReactNode;
  uploadBusy?: boolean;
  hasUploads?: boolean;
}

export default function TicketComposer({
  ticketId,
  message,
  onMessageChange,
  files,
  onFilesChange,
  onSubmit,
  pending,
  uploadProgress,
  uploadSlot,
  uploadBusy = false,
  hasUploads = false,
}: TicketComposerProps) {
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveTicketDraft(ticketId, message), DRAFT_SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [ticketId, message]);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && (message.trim() || hasUploads) && !pending && !uploadBusy) {
      e.preventDefault();
      onSubmit();
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="card min-w-0 p-3 mt-3"
    >
      <Textarea
        aria-label={t("web.support_reply")}
        disabled={pending}
        className="min-h-0 max-h-40 resize-y [field-sizing:content]"
        value={message}
        onChange={(e) => onMessageChange(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={2}
        required={!hasUploads}
        maxLength={MAX_MESSAGE_LENGTH}
        placeholder={t("web.support_placeholder")}
      />
      <div className="mt-1 flex items-center justify-between text-xs text-ink-faint">
        <span>{t("web.ticket_composer_shortcut")}</span>
        <span>
          {message.length}/{MAX_MESSAGE_LENGTH}
        </span>
      </div>
      {uploadSlot ?? <AttachmentPicker files={files} onChange={onFilesChange} disabled={pending} />}
      {pending && files.length > 0 && (
        <div className="mt-2">
          <ProgressBar value={uploadProgress} />
        </div>
      )}
      <div className="mt-3 text-right">
        <Button type="submit" variant="primary" size="sm" disabled={pending || uploadBusy || (!message.trim() && !hasUploads)}>
          {pending && <Spinner />}
          <Send className="w-3.5 h-3.5" /> {t("web.support_reply")}
        </Button>
      </div>
    </form>
  );
}
