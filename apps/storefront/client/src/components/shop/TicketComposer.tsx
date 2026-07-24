/** Reply composer for the ticket thread — textarea + attachments + char
 * counter + Ctrl/Cmd+Enter shortcut + debounced draft autosave. Fully
 * controlled: the parent owns `message`/`files` and passes `onSubmit`; this
 * component only *saves* drafts on change (see lib/ticketDraft.ts) — loading
 * the initial draft and clearing it on success are the parent's job, since
 * those need to happen exactly once at mount / on mutation success. */
import { useEffect, useRef, type KeyboardEvent } from "react";
import { Send } from "lucide-react";
import { t } from "../../lib/i18n";
import { saveTicketDraft } from "../../lib/ticketDraft";
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
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && message.trim() && !pending) {
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
      className="card card-pad mt-5"
    >
      <textarea
        value={message}
        onChange={(e) => onMessageChange(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={3}
        required
        maxLength={MAX_MESSAGE_LENGTH}
        className="field"
        placeholder={t("web.support_placeholder")}
      />
      <div className="mt-1 flex items-center justify-between text-xs text-ink-faint">
        <span>{t("web.ticket_composer_shortcut")}</span>
        <span>
          {message.length}/{MAX_MESSAGE_LENGTH}
        </span>
      </div>
      <AttachmentPicker files={files} onChange={onFilesChange} disabled={pending} />
      {pending && files.length > 0 && (
        <div className="mt-2">
          <ProgressBar value={uploadProgress} />
        </div>
      )}
      <div className="mt-3 text-right">
        <button type="submit" className="btn btn-primary btn-sm" disabled={pending || !message.trim()}>
          {pending && <Spinner />}
          <Send className="w-3.5 h-3.5" /> {t("web.support_reply")}
        </button>
      </div>
    </form>
  );
}
