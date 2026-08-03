import { useEffect, useState } from "react";
import { CircleCheckIcon, Loader2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProgressBar } from "@/components/shared/ProgressBar";

function csrfToken(): string {
  return (
    document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") ?? ""
  );
}

/** The literal 403 body `handleUpload()` (apps/web-admin/src/lib/upload.ts)
 * sends when the form's `csrf_token` doesn't match the current session —
 * happens when this tab's meta tag was baked in under an older session that
 * a newer login (another tab/device) has since silently replaced (every
 * `POST /login` rotates the one stored session token per admin). The fix is
 * a full reload to pick up the current session's token. */
const CSRF_FAILURE_BODY = "CSRF check failed";
const STALE_SESSION_MESSAGE = "Your session was refreshed in another tab. Reload this page to continue.";

/** The two phases a Save actually goes through: bytes leaving the browser
 * (`sending`, driven by real upload progress), then the server doing its own
 * work — sniffing, a DB read, file unlinks, a `writeFile`, and a couple of
 * sequential writes against the shared single-writer SQLite (`processing`,
 * which has no progress signal at all). Collapsing both into one "uploading"
 * boolean is what made a frozen `Saving… 100%` indistinguishable from a
 * genuine hang. */
type UploadPhase = "idle" | "sending" | "processing";

/** Sized off the documented 5MB ceiling on an ordinary mobile uplink: at
 * ~500 kbps that is roughly 80 seconds of transfer before the server has done
 * any work at all, so a 60s cap would abort legitimate uploads and hand the
 * user advice ("check your connection") that fails identically on retry. 120s
 * covers that transfer plus the server-side work described above, while still
 * turning a truly stuck request into a clear error instead of leaving the
 * button spinning forever. */
const UPLOAD_TIMEOUT_MS = 120_000;
const TIMEOUT_MESSAGE = "The server took too long to respond. Check your connection and try again.";

/** `fetch` has no reliable cross-browser way to report request-upload
 * progress; `XMLHttpRequest.upload.onprogress` does. */
function uploadWithProgress(
  url: string,
  form: FormData,
  onProgress: (pct: number) => void,
  onPhaseChange: (phase: UploadPhase) => void,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.withCredentials = true;
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    // Fires once every byte has left the browser — well before the server
    // has even started working — so this is the honest point to switch the
    // UI from "here's real progress" to "please wait, no progress to show".
    xhr.upload.onload = () => onPhaseChange("processing");
    xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
    xhr.onerror = () => reject(new Error("Network error during upload."));
    xhr.ontimeout = () => reject(new Error(TIMEOUT_MESSAGE));
    xhr.send(form);
  });
}

/** Save button label/content for each phase — shared by both the `row` and
 * `dropzone` variants so they can't drift apart on this. */
function saveButtonContent(phase: UploadPhase, uploadProgress: number): React.ReactNode {
  if (phase === "processing") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        Finishing up…
      </span>
    );
  }
  if (phase === "sending") {
    return `Saving…${uploadProgress > 0 ? ` ${uploadProgress}%` : ""}`;
  }
  return "Save";
}

/**
 * Multipart image upload row: shows the current image (if any), a file picker,
 * and posts directly to a non-`/api` multipart route (CSRF is sent as a
 * `csrf_token` form field, since it's the only way `handleUpload()` on the
 * server reads it out of a multipart body). Picking a file stages a local
 * preview; the request only fires once the user clicks Save (Cancel discards
 * the pick and reverts to the current image). `onUploaded` receives the
 * saved file's URL, so callers with no persisted record of their own (e.g. a
 * broadcast draft) can stash it locally instead of refetching. Shared by
 * Branding, Catalog, and Broadcast.
 */
/** Maps each `accept` extension to the MIME type(s) the browser reports for
 * it, so a picked file can be checked against the same allow-list the server
 * enforces without duplicating each route's MIME table here. */
const EXT_MIME: Record<string, string[]> = {
  ".png": ["image/png"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".webp": ["image/webp"],
  ".svg": ["image/svg+xml"],
  ".ico": ["image/x-icon", "image/vnd.microsoft.icon"],
};

export function ImageUploadField({
  label,
  imageUrl,
  uploadPath,
  fieldName,
  accept,
  onUploaded,
  dimensions,
  showSuccessCheckmark = false,
  maxBytes,
  variant = "row",
  onRemove,
}: {
  label: string;
  imageUrl: string;
  uploadPath: string;
  fieldName: string;
  accept: string;
  onUploaded: (url: string) => void;
  dimensions?: string;
  /** Briefly shows a checkmark in place of the Save/Cancel row after a
   * successful upload. Opt-in (default off) since this component is also
   * used by Catalog and Broadcast, where the plain instant-revert is fine. */
  showSuccessCheckmark?: boolean;
  /** Server-side size cap for this field (see the route's `handleUpload`
   * call) — checked client-side too so an oversized/wrong-type pick is
   * rejected instantly instead of only after a full upload round-trip. */
  maxBytes?: number;
  /** Visual layout: `"row"` (default) is the original compact
   * label+thumbnail+"Choose file…" row used by Branding/Catalog.
   * `"dropzone"` is an opt-in dashed-border drop-zone look used by
   * Broadcast; Branding/Catalog never pass this and keep rendering the
   * `row` branch unchanged. */
  variant?: "row" | "dropzone";
  /** Only meaningful in the `dropzone` variant: clears the parent's
   * persisted `imageUrl` when the user removes an already-saved image.
   * `cancelPending()` can't do this itself since it only clears an
   * unsaved local pick, not the parent-owned `imageUrl` prop. */
  onRemove?: () => void;
}) {
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [staleSession, setStaleSession] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const uploading = phase !== "idle";

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const allowedMimes = accept
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .flatMap((token) => (token.includes("/") ? [token] : EXT_MIME[token] ?? []));
    if (allowedMimes.length > 0 && !allowedMimes.includes(file.type)) {
      setUploadError("That file type is not allowed.");
      return;
    }
    if (maxBytes && file.size > maxBytes) {
      const maxMb = (maxBytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "");
      setUploadError(`That file is too large (max ${maxMb}MB).`);
      return;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setUploadError(null);
    setPendingFile(file);
    setPreviewUrl(URL.createObjectURL(file));
  }

  function cancelPending() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPendingFile(null);
    setPreviewUrl(null);
    setUploadError(null);
  }

  async function confirmUpload() {
    if (!pendingFile) return;
    setPhase("sending");
    setUploadProgress(0);
    setUploadError(null);
    setStaleSession(false);
    const form = new FormData();
    form.append(fieldName, pendingFile);
    form.append("csrf_token", csrfToken());
    try {
      const { status, body } = await uploadWithProgress(uploadPath, form, setUploadProgress, setPhase);
      if (status < 200 || status >= 300) {
        if (status === 403 && body === CSRF_FAILURE_BODY) {
          setStaleSession(true);
          throw new Error(STALE_SESSION_MESSAGE);
        }
        throw new Error(body || `Upload failed (${status})`);
      }
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPendingFile(null);
      setPreviewUrl(null);
      const { url } = JSON.parse(body) as { url: string };
      onUploaded(url);
      if (showSuccessCheckmark) {
        setJustSaved(true);
        setTimeout(() => setJustSaved(false), 800);
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setPhase("idle");
    }
  }

  const displayUrl = previewUrl ?? imageUrl;

  if (variant === "dropzone") {
    return (
      <div>
        {dimensions && <p className="text-xs text-ink-soft mb-2">Recommended: {dimensions}</p>}
        {displayUrl && !pendingFile ? (
          <div className="relative inline-block">
            <img src={displayUrl} alt={label} className="max-h-40 max-w-full block rounded-lg border border-line" />
            {onRemove && (
              <button
                type="button"
                aria-label="Remove image"
                onClick={onRemove}
                className="absolute -right-2 -top-2 rounded-full bg-card border border-line p-1 shadow-soft hover:bg-sand"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ) : (
          <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-line bg-sand/40 px-6 py-8 text-center hover:bg-sand">
            <input type="file" accept={accept} onChange={handleFile} disabled={uploading} className="hidden" />
            <Upload className="h-5 w-5 text-ink-faint" />
            <span className="text-sm text-ink">Browse image</span>
            <span className="text-xs text-ink-soft">PNG/JPG/WebP • Max 5MB</span>
          </label>
        )}
        {justSaved ? (
          <div className="flex items-center gap-1.5 mt-2 text-sm text-grass-dark">
            <CircleCheckIcon className="size-4 motion-safe:animate-checkmark-pop" /> Saved
          </div>
        ) : (
          pendingFile && (
            <div className="mt-2">
              <div className="flex gap-2">
                <Button size="sm" disabled={uploading} onClick={() => void confirmUpload()}>
                  {saveButtonContent(phase, uploadProgress)}
                </Button>
                <Button size="sm" variant="ghost" disabled={uploading} onClick={cancelPending}>Cancel</Button>
              </div>
              {phase === "sending" && <ProgressBar value={uploadProgress} tone="grass" className="mt-2" />}
            </div>
          )
        )}
        {uploadError && (
          <div className="mt-1 flex items-center gap-2">
            <p className="text-xs text-rust">{uploadError}</p>
            {staleSession && <Button size="sm" variant="ghost" onClick={() => window.location.reload()}>Reload page</Button>}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="py-3 border-b border-line last:border-b-0">
      <div className="text-sm font-medium text-ink mb-1">{label}</div>
      {dimensions && (
        <p className="text-xs text-ink-soft mb-2">Recommended: {dimensions}</p>
      )}
      {displayUrl ? (
        <img
          src={displayUrl}
          alt={label}
          className="max-h-20 max-w-[200px] block mb-2 border border-line rounded"
        />
      ) : (
        <p className="text-xs text-ink-soft mb-2">No image set</p>
      )}
      <label className="cursor-pointer">
        <input
          type="file"
          accept={accept}
          onChange={handleFile}
          disabled={uploading}
          className="hidden"
        />
        <span className="inline-flex items-center rounded border border-line bg-card px-3 py-1 text-sm text-ink hover:bg-sand">
          Choose file…
        </span>
      </label>
      {justSaved ? (
        <div className="flex items-center gap-1.5 mt-2 text-sm text-grass-dark">
          <CircleCheckIcon className="size-4 motion-safe:animate-checkmark-pop" />
          Saved
        </div>
      ) : (
        pendingFile && (
          <div className="mt-2">
            <div className="flex gap-2">
              <Button size="sm" disabled={uploading} onClick={() => void confirmUpload()}>
                {saveButtonContent(phase, uploadProgress)}
              </Button>
              <Button size="sm" variant="ghost" disabled={uploading} onClick={cancelPending}>
                Cancel
              </Button>
            </div>
            {phase === "sending" && <ProgressBar value={uploadProgress} tone="grass" className="mt-2" />}
          </div>
        )
      )}
      {uploadError && (
        <div className="mt-1 flex items-center gap-2">
          <p className="text-xs text-rust">{uploadError}</p>
          {staleSession && (
            <Button size="sm" variant="ghost" onClick={() => window.location.reload()}>
              Reload page
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
