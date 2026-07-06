import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

function csrfToken(): string {
  return (
    document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") ?? ""
  );
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
export function ImageUploadField({
  label,
  imageUrl,
  uploadPath,
  fieldName,
  accept,
  onUploaded,
  dimensions,
}: {
  label: string;
  imageUrl: string;
  uploadPath: string;
  fieldName: string;
  accept: string;
  onUploaded: (url: string) => void;
  dimensions?: string;
}) {
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
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
    setUploading(true);
    setUploadError(null);
    const form = new FormData();
    form.append(fieldName, pendingFile);
    form.append("csrf_token", csrfToken());
    try {
      const res = await fetch(uploadPath, {
        method: "POST",
        credentials: "include",
        body: form,
      });
      if (!res.ok) {
        const message = await res.text().catch(() => "");
        throw new Error(message || `Upload failed (${res.status})`);
      }
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPendingFile(null);
      setPreviewUrl(null);
      const { url } = (await res.json()) as { url: string };
      onUploaded(url);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  const displayUrl = previewUrl ?? imageUrl;

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
      {pendingFile && (
        <div className="flex gap-2 mt-2">
          <Button size="sm" disabled={uploading} onClick={() => void confirmUpload()}>
            {uploading ? "Saving…" : "Save"}
          </Button>
          <Button size="sm" variant="ghost" disabled={uploading} onClick={cancelPending}>
            Cancel
          </Button>
        </div>
      )}
      {uploadError && (
        <p className="mt-1 text-xs text-rust">{uploadError}</p>
      )}
    </div>
  );
}
