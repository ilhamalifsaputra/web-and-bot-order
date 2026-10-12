import { useEffect, useState } from "react";

/** Object URL lifetime follows the mounted preview, including StrictMode. */
export function SupportFilePreview({ file }: { file: File }) {
  const [preview, setPreview] = useState<{ file: File; url: string } | null>(null);
  useEffect(() => {
    if (typeof URL.createObjectURL !== "function") return;
    const url = URL.createObjectURL(file);
    setPreview({ file, url });
    return () => URL.revokeObjectURL(url);
  }, [file]);
  if (preview?.file !== file) return null;
  return file.type === "video/mp4" ? <video src={preview.url} controls preload="none" className="h-16 w-20 shrink-0 rounded object-cover" aria-label={file.name} />
    : <img src={preview.url} alt={file.name} width={40} height={40} className="h-10 w-10 shrink-0 rounded object-cover" />;
}
