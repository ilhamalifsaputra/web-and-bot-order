import { SupportFilePreview } from "./SupportFilePreview";
import { Button } from "@/components/ui/button";
import type { useSupportUploads } from "@/lib/supportUploads";
import { useId } from "react";

export function SupportUploadPicker({ uploads, enabled, disabled }: { uploads: ReturnType<typeof useSupportUploads>; enabled: boolean; disabled: boolean }) {
  const id = useId();
  return <div className="min-w-0 space-y-2">
    <label htmlFor={id} className="text-xs font-medium">Evidence (optional)</label>
    {enabled ? <input id={id} type="file" multiple accept="image/jpeg,image/png,image/webp,video/mp4" disabled={disabled || uploads.files.length >= 3} className="block w-full min-w-0 text-xs file:mr-2 file:rounded-md file:border-0 file:bg-sand file:px-3 file:py-2" onChange={(event) => { uploads.add(Array.from(event.target.files ?? [])); event.target.value = ""; }} /> : <p className="text-xs text-ink-soft">Attachments unavailable. Configure private R2 to enable uploads.</p>}
    <p className="text-xs text-ink-soft">Up to 3 files · JPG, PNG, WebP ≤{uploads.limits.imageBytes / 1024 ** 2} MB · MP4 ≤{uploads.limits.videoBytes / 1024 ** 2} MB</p>
    <ul className="space-y-2" aria-live="polite">{uploads.files.map((file) => <li key={file.key} className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-line p-2 text-xs"><SupportFilePreview file={file.file} /><div className="min-w-0 flex-1"><p className="truncate" title={file.file.name}>{file.file.name}</p><p>{file.state === "uploading" ? `Uploading ${file.progress}%` : file.state}</p>{file.error && <p role="alert">{file.error}</p>}{file.state === "uploading" && <progress value={file.progress} max={100} aria-label={file.file.name} className="h-1 w-full accent-pine" />}</div>{file.state === "failed" && <Button size="sm" variant="outline" disabled={(file.attempts ?? 0) >= 3} onClick={() => void uploads.retry(file)}>Retry</Button>}<Button size="sm" variant="ghost" disabled={disabled} onClick={() => uploads.remove(file)}>Remove</Button></li>)}</ul>
  </div>;
}
