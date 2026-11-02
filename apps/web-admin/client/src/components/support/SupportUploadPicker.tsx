import { SupportFilePreview } from "./SupportFilePreview";
import { Button } from "@/components/ui/button";
import type { SupportUpload, useSupportUploads } from "@/lib/supportUploads";
import { CircleAlert, CloudUpload, FileCheck, FileX, LoaderCircle } from "lucide-react";
import { useId } from "react";

export type SupportUploadOptionsState = "loading" | "error" | "disabled" | "enabled";

/**
 * One file's state in words plus a decorative icon (UI-states audit, visual
 * standard): uploading (cloud-upload, info), checking (loader), uploaded
 * (file-check, success), failed (file-x, destructive). A percentage appears
 * only once the browser has reported measurable progress, never a made-up 0%.
 */
function FileStateLine({ file }: { file: SupportUpload }) {
  if (file.state === "uploading") {
    return <p className="flex items-center gap-1 text-pine-dark"><CloudUpload className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{file.progress > 0 ? `Uploading ${file.progress}%` : "Uploading"}</p>;
  }
  if (file.state === "verifying") {
    return <p className="flex items-center gap-1 text-ink-soft"><LoaderCircle className="h-3.5 w-3.5 shrink-0 motion-safe:animate-spin" aria-hidden="true" />Verifying…</p>;
  }
  if (file.state === "ready") {
    return <p className="flex items-center gap-1 text-grass-dark"><FileCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />Uploaded</p>;
  }
  return <p className="flex items-center gap-1 font-medium text-rust"><FileX className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />Failed</p>;
}

export function SupportUploadPicker({ uploads, optionsState, onRetryOptions, disabled }: { uploads: ReturnType<typeof useSupportUploads>; optionsState: SupportUploadOptionsState; onRetryOptions: () => void; disabled: boolean }) {
  const id = useId();
  return <div className="min-w-0 space-y-2">
    <label htmlFor={id} className="text-xs font-medium">Evidence (optional)</label>
    {optionsState === "enabled" && <input id={id} type="file" multiple accept="image/jpeg,image/png,image/webp,video/mp4" disabled={disabled || uploads.files.length >= 3} className="block w-full min-w-0 text-xs file:mr-2 file:rounded-md file:border-0 file:bg-sand file:px-3 file:py-2" onChange={(event) => { uploads.add(Array.from(event.target.files ?? [])); event.target.value = ""; }} />}
    {optionsState === "loading" && <p className="text-xs text-ink-soft" role="status">Checking attachments…</p>}
    {optionsState === "error" && <div className="flex flex-wrap items-center gap-2 text-xs text-rust" role="alert"><CircleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span>Could not check whether attachments are available.</span><Button size="sm" variant="outline" onClick={onRetryOptions}>Retry</Button></div>}
    {optionsState === "disabled" && <p className="text-xs text-ink-soft">Attachments unavailable. Configure private R2 to enable uploads.</p>}
    <p className="text-xs text-ink-soft">Up to 3 files · JPG, PNG, WebP ≤{uploads.limits.imageBytes / 1024 ** 2} MB · MP4 ≤{uploads.limits.videoBytes / 1024 ** 2} MB</p>
    <ul className="space-y-2" aria-live="polite">{uploads.files.map((file) => <li key={file.key} className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-line p-2 text-xs"><SupportFilePreview file={file.file} /><div className="min-w-0 flex-1"><p className="truncate" title={file.file.name}>{file.file.name}</p><FileStateLine file={file} />{file.error && <p role="alert" className="text-rust">{file.error}</p>}{file.state === "uploading" && file.progress > 0 && <progress value={file.progress} max={100} aria-label={file.file.name} className="h-1 w-full accent-pine" />}</div>{file.state === "failed" && <Button size="sm" variant="outline" disabled={(file.attempts ?? 0) >= 3} onClick={() => void uploads.retry(file)}>Retry</Button>}<Button size="sm" variant="ghost" disabled={disabled} onClick={() => uploads.remove(file)}>Remove</Button></li>)}</ul>
  </div>;
}
