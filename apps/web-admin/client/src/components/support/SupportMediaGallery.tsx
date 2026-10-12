import { useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

export function SupportMediaGallery({ urls }: { urls: string[] }) {
  const [preview, setPreview] = useState<string | null>(null);
  if (!urls.length) return null;
  return <div className="mt-2 flex min-w-0 flex-wrap gap-2">
    {urls.map((url) => /\.mp4(?:\?|$)/i.test(url) ? <video key={url} src={url} controls preload="none" aria-label="Video evidence" className="aspect-video w-48 max-w-full rounded-md border border-line" /> : <button key={url} type="button" aria-label="Preview image evidence" className="rounded-md border border-line focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setPreview(url)}><img src={url} alt="Evidence" loading="lazy" width={80} height={80} className="h-20 w-20 rounded-md object-cover" /></button>)}
    <Dialog open={preview !== null} onOpenChange={(open) => { if (!open) setPreview(null); }}><DialogContent className="max-h-[85dvh] overflow-auto sm:max-w-2xl"><DialogTitle>Evidence</DialogTitle>{preview && <img src={preview} alt="Evidence preview" className="max-h-[70dvh] w-full object-contain" />}</DialogContent></Dialog>
  </div>;
}
