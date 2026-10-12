import { SupportFilePreview } from "./SupportFilePreview";
import { Paperclip, RotateCcw, X } from "lucide-react";
import { useId } from "react";
import { t } from "../../lib/i18n";
import type { useSupportUploads } from "../../lib/supportUploads";
import Button from "../ui/Button";

export default function SupportUploadPicker({ uploads, enabled = true, disabled = false }: { uploads: ReturnType<typeof useSupportUploads>; enabled?: boolean; disabled?: boolean }) {
  const id = useId();
  return <div className="min-w-0 space-y-2">
    <label htmlFor={id} className="flex items-center gap-2 text-sm font-medium text-ink"><Paperclip className="h-4 w-4" aria-hidden="true" />{t("helpdesk.attachments")}</label>
    {enabled ? <input id={id} type="file" multiple accept="image/jpeg,image/png,image/webp,video/mp4" disabled={disabled || uploads.files.length >= 3} className="block w-full min-w-0 text-xs text-ink-soft file:mr-3 file:rounded-md file:border-0 file:bg-sand file:px-3 file:py-2 file:font-medium file:text-ink" onChange={(e) => { uploads.add(Array.from(e.target.files ?? [])); e.target.value = ""; }} /> : <p className="text-xs text-ink-soft">{t("helpdesk.media_unavailable")}</p>}
    <p className="text-xs text-ink-soft">{t("helpdesk.media_limits_dynamic", { image: String(uploads.limits.imageBytes / 1024 ** 2), video: String(uploads.limits.videoBytes / 1024 ** 2) })}</p>
    <ul className="space-y-2" aria-live="polite">{uploads.files.map((file) => <li key={file.key} className="flex min-w-0 items-center gap-2 rounded-md border border-line p-2 text-xs">
      <SupportFilePreview file={file.file} /><div className="min-w-0 flex-1"><p className="truncate font-medium" title={file.file.name}>{file.file.name}</p><p className="text-ink-soft">{file.state === "uploading" ? `${t("helpdesk.uploading")} ${file.progress}%` : t(`helpdesk.upload_${file.state}`)}</p>{file.error && <p role="alert">{file.error}</p>}{file.state === "uploading" && <progress aria-label={file.file.name} value={file.progress} max={100} className="h-1 w-full accent-pine" />}</div>
      {file.state === "failed" && <Button size="sm" variant="soft" disabled={(file.attempts ?? 0) >= 3} aria-label={t("helpdesk.retry")} onClick={() => void uploads.retry(file)}><RotateCcw className="h-4 w-4" /></Button>}
      <Button size="sm" variant="soft" disabled={disabled} aria-label={t("helpdesk.remove")} onClick={() => uploads.remove(file)}><X className="h-4 w-4" /></Button>
    </li>)}</ul>
  </div>;
}
