import { FilePreview } from "./FilePreview";
/**
 * Evidence attach control for the support-ticket forms (new ticket + reply).
 * Client-side type/size/count checks mirror the server's
 * (apps/storefront/src/lib/ticketAttachments.ts) but are defense-in-depth
 * only — the server is the real gate. Picking a file stages it in the
 * caller's state; nothing uploads until the surrounding form submits
 * (SupportPage/TicketDetailPage build the FormData and POST via
 * apiPostFormWithProgress).
 */
import { useRef, useState, type ChangeEvent } from "react";
import { Paperclip, X } from "lucide-react";
import { t } from "../../lib/i18n";
import { MAX_TICKET_ATTACHMENTS, validateNewFiles } from "../../lib/attachmentValidation";
import { useFileRows } from "../../hooks/useFileRows";

// Re-exported for back-compat: other files import this constant from here.
export { MAX_TICKET_ATTACHMENTS };

export interface AttachmentPickerProps {
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
}

export default function AttachmentPicker({ files, onChange, disabled }: AttachmentPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const rows = useFileRows(files);

  function handlePick(e: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (picked.length === 0) return;
    setError(null);
    const { accepted, errorKey } = validateNewFiles(files, picked);
    if (errorKey) setError(t(errorKey));
    onChange([...files, ...accepted]);
  }

  function removeAt(idx: number) {
    onChange(files.filter((_, i) => i !== idx));
  }

  const atLimit = files.length >= MAX_TICKET_ATTACHMENTS;

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled || atLimit}
        className="btn btn-sm bg-sand text-ink border border-line hover:bg-line/40 disabled:opacity-50"
      >
        <Paperclip className="w-3.5 h-3.5" /> {t("web.support_attach")}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime"
        multiple
        onChange={handlePick}
        className="hidden"
      />
      <p className="mt-1.5 text-xs text-ink-faint">{t("web.support_attach_hint")}</p>
      {error && <p className="mt-1 text-xs text-rust">{error}</p>}
      {files.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {rows.map(({ file, id, index }) => (
            <li
              key={id}
              className="flex items-center gap-2 rounded-md border border-line bg-card px-2 py-1 text-xs"
            >
              <FilePreview file={file} />
              <span className="max-w-[8rem] truncate">{file.name}</span>
              <button
                type="button"
                onClick={() => removeAt(index)}
                aria-label={t("web.support_attach_remove")}
                className="-mr-1 rounded p-1 text-ink-faint hover:text-rust"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
