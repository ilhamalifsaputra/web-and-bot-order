import { useState } from "react";

function csrfToken(): string {
  return (
    document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") ?? ""
  );
}

/**
 * Multipart image upload row: shows the current image (if any), a file picker,
 * and posts directly to a non-`/api` multipart route (CSRF is checked from the
 * `X-CSRF-Token` header inside the route's `handleUpload()` call, since Fastify's
 * formbody plugin doesn't parse multipart bodies). Shared by Branding and Catalog.
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
  onUploaded: () => void;
  dimensions?: string;
}) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    const form = new FormData();
    form.append(fieldName, file);
    try {
      const res = await fetch(uploadPath, {
        method: "POST",
        credentials: "include",
        headers: { "X-CSRF-Token": csrfToken() },
        body: form,
      });
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);
      onUploaded();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  return (
    <div className="py-3 border-b border-line last:border-b-0">
      <div className="text-sm font-medium text-ink mb-1">{label}</div>
      {dimensions && (
        <p className="text-xs text-ink-soft mb-2">Recommended: {dimensions}</p>
      )}
      {imageUrl ? (
        <img
          src={imageUrl}
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
          className="hidden"
        />
        <span className="inline-flex items-center rounded border border-line bg-card px-3 py-1 text-sm text-ink hover:bg-sand">
          {uploading ? "Uploading…" : "Choose file…"}
        </span>
      </label>
      {uploadError && (
        <p className="mt-1 text-xs text-rust">{uploadError}</p>
      )}
    </div>
  );
}
