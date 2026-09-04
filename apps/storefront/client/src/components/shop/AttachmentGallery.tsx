/**
 * Read-only render of a ticket/message's evidence URLs (SupportPage's
 * `attachments`/TicketDetailPage's thread) — image extensions render as a
 * clickable thumbnail (opens the original in a new tab), video extensions
 * render as an inline `<video controls>` player. Each item also gets a small
 * filename + download link beneath it (InlineTicketPanel/Task 17) — the
 * server stores only a URL, not the original filename or byte size, so the
 * name shown is derived from the URL's basename and no size is shown.
 */
import { Download } from "lucide-react";

const VIDEO_EXT = new Set(["mp4", "webm", "mov"]);

function extOf(url: string): string {
  const clean = url.split("?")[0] ?? url;
  const dot = clean.lastIndexOf(".");
  return dot === -1 ? "" : clean.slice(dot + 1).toLowerCase();
}

function basenameOf(url: string): string {
  const clean = url.split("?")[0] ?? url;
  const seg = clean.split("/").pop() || clean;
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

export default function AttachmentGallery({ urls }: { urls: string[] }) {
  if (urls.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {urls.map((url) => (
        <div key={url} className="flex flex-col items-start gap-1">
          {VIDEO_EXT.has(extOf(url)) ? (
            <video src={url} controls className="w-40 max-w-full rounded-md border border-line bg-ink/5" />
          ) : (
            <a href={url} target="_blank" rel="noreferrer" className="block rounded-md border border-line overflow-hidden">
              <img src={url} alt="" className="w-20 h-20 object-cover" />
            </a>
          )}
          <a href={url} download className="inline-flex items-center gap-1 text-xs text-ink-faint hover:text-pine">
            <Download className="w-3 h-3" /> {basenameOf(url)}
          </a>
        </div>
      ))}
    </div>
  );
}
