/**
 * Dashed drop-zone evidence picker for the /help create-ticket form
 * (NewTicketCard, a later task). A visually distinct sibling of
 * AttachmentPicker.tsx — a full-width dashed box with drag-and-drop rather
 * than a small button — but every count/type/size rule comes from the shared
 * lib/attachmentValidation.ts, so both controls accept exactly the same
 * files. Controlled: the parent owns `files`; picking or dropping only stages
 * files in the caller's state, nothing uploads until the surrounding form
 * submits.
 */
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { Paperclip, FileVideo, X } from "lucide-react";
import { t } from "../../lib/i18n";
import { MAX_TICKET_ATTACHMENTS, IMAGE_TYPES, validateNewFiles } from "../../lib/attachmentValidation";

export interface EvidenceUploaderProps {
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
}

export default function EvidenceUploader({ files, onChange, disabled }: EvidenceUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const previewUrls = useMemo(
    () => files.map((f) => (IMAGE_TYPES.has(f.type) ? URL.createObjectURL(f) : null)),
    [files],
  );
  useEffect(() => {
    return () => {
      previewUrls.forEach((u) => u && URL.revokeObjectURL(u));
    };
  }, [previewUrls]);

  const atLimit = files.length >= MAX_TICKET_ATTACHMENTS;

  // The single validation path the file <input> and drag-and-drop both feed
  // into, so a dropped file is checked exactly like a picked one.
  function ingestFiles(incoming: File[]) {
    if (incoming.length === 0) return;
    setError(null);
    const { accepted, errorKey } = validateNewFiles(files, incoming);
    if (errorKey) setError(t(errorKey));
    onChange([...files, ...accepted]);
  }

  function handlePick(e: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = "";
    ingestFiles(picked);
  }

  function handleDragOver(e: DragEvent<HTMLButtonElement>) {
    if (disabled || atLimit) return;
    e.preventDefault(); // let the browser deliver a drop to this element
    setIsDragOver(true);
  }

  function handleDragLeave() {
    setIsDragOver(false);
  }

  function handleDrop(e: DragEvent<HTMLButtonElement>) {
    e.preventDefault();
    setIsDragOver(false);
    if (disabled || atLimit) return;
    ingestFiles(Array.from(e.dataTransfer?.files ?? []));
  }

  function removeAt(idx: number) {
    onChange(files.filter((_, i) => i !== idx));
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        disabled={disabled || atLimit}
        className={`flex min-h-24 w-full flex-col items-start gap-1 rounded-xl border-2 border-dashed px-4 py-5 text-left disabled:opacity-50 ${
          isDragOver ? "border-pine bg-pine-tint/30" : "border-line bg-paper"
        }`}
      >
        <span className="flex items-center gap-2">
          <Paperclip className="h-4 w-4 text-pine" />
          <span className="font-medium text-pine">{t("web.support_attach_cta")}</span>
        </span>
        <span className="text-xs text-ink-soft">{t("web.support_attach_help")}</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime"
        multiple
        onChange={handlePick}
        className="hidden"
      />
      <p className="mt-1.5 text-xs text-ink-faint">{t("web.support_attach_limits")}</p>
      {error && (
        <p role="alert" className="mt-1 text-xs text-rust">
          {error}
        </p>
      )}
      {files.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {files.map((file, idx) => (
            // L2 nested surface. These rows sit inside NewTicketCard's white
            // `.card` form; the old `bg-card` made them white-on-white, the one
            // real camouflage instance on /help. `.card-2` recesses them onto
            // sand. Padding stays the compact `px-2 py-1` — `card-pad-2`'s 1rem
            // is a panel padding, not a chip padding.
            <li
              key={`${file.name}-${idx}`}
              className="card-2 flex items-center gap-2 px-2 py-1 text-xs"
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
