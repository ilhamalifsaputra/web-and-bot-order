import { FileVideo } from "lucide-react";
import { useEffect, useState } from "react";
import { IMAGE_TYPES } from "../../lib/attachmentValidation";

export function FilePreview({ file }: { file: File }) {
  const [preview, setPreview] = useState<{ file: File; url: string } | null>(null);
  useEffect(() => {
    if (!IMAGE_TYPES.has(file.type)) return;
    const url = URL.createObjectURL(file);
    setPreview({ file, url });
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return preview?.file === file ? <img src={preview.url} alt="" className="w-6 h-6 rounded object-cover" />
    : <FileVideo className="w-4 h-4 text-ink-soft shrink-0" />;
}
