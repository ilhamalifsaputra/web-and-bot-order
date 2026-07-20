/**
 * Evidence attach control for the support-ticket forms (new ticket + reply).
 * Client-side type/size/count checks mirror the server's
 * (apps/storefront/src/lib/ticketAttachments.ts) but are defense-in-depth
 * only — the server is the real gate. Picking a file stages it in the
 * caller's state; nothing uploads until the surrounding form submits
 * (SupportPage/TicketDetailPage build the FormData and POST via apiPostForm).
 */
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Paperclip, FileVideo, X } from "lucide-react";
import { t } from "../../lib/i18n";

export const MAX_TICKET_ATTACHMENTS = 3;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);

export interface AttachmentPickerProps {
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
}

export default function AttachmentPicker({ files, onChange, disabled }: AttachmentPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const previewUrls = useMemo(
    () => files.map((f) => (IMAGE_TYPES.has(f.type) ? URL.createObjectURL(f) : null)),
    [files],
  );
  useEffect(() => {
    return () => {
      previewUrls.forEach((u) => u && URL.revokeObjectURL(u));
    };
  }, [previewUrls]);

  function handlePick(e: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (picked.length === 0) return;
    setError(null);
    const next = [...files];
    for (const file of picked) {
      if (next.length >= MAX_TICKET_ATTACHMENTS) {
        setError(t("web.support_attach_error_count"));
        break;
      }
      const isImage = IMAGE_TYPES.has(file.type);
      const isVideo = VIDEO_TYPES.has(file.type);
      if (!isImage && !isVideo) {
        setError(t("web.support_attach_error_type"));
        continue;
      }
      if ((isImage && file.size > MAX_IMAGE_BYTES) || (isVideo && file.size > MAX_VIDEO_BYTES)) {
        setError(t("web.support_attach_error_size"));
        continue;
      }
      next.push(file);
    }
    onChange(next);
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
          {files.map((file, idx) => (
            <li
              key={`${file.name}-${idx}`}
              className="flex items-center gap-1.5 rounded-md border border-line bg-card px-2 py-1 text-xs"
            >
              {previewUrls[idx] ? (
                <img src={previewUrls[idx]!} alt="" className="w-6 h-6 rounded object-cover" />
              ) : (
                <FileVideo className="w-4 h-4 text-ink-soft shrink-0" />
              )}
              <span className="max-w-[8rem] truncate">{file.name}</span>
              <button
                type="button"
                onClick={() => removeAt(idx)}
                aria-label={t("web.support_attach_remove")}
                className="text-ink-faint hover:text-rust"
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
