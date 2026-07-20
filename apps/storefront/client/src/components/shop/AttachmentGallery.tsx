/**
 * Read-only render of a ticket/message's evidence URLs (SupportPage's
 * `attachments`/TicketDetailPage's thread) — image extensions render as a
 * clickable thumbnail (opens the original in a new tab), video extensions
 * render as an inline `<video controls>` player.
 */
const VIDEO_EXT = new Set(["mp4", "webm", "mov"]);

function extOf(url: string): string {
  const clean = url.split("?")[0] ?? url;
  const dot = clean.lastIndexOf(".");
  return dot === -1 ? "" : clean.slice(dot + 1).toLowerCase();
}

export default function AttachmentGallery({ urls }: { urls: string[] }) {
  if (urls.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {urls.map((url) =>
        VIDEO_EXT.has(extOf(url)) ? (
          <video key={url} src={url} controls className="w-40 max-w-full rounded-md border border-line bg-ink/5" />
        ) : (
          <a key={url} href={url} target="_blank" rel="noreferrer" className="block rounded-md border border-line overflow-hidden">
            <img src={url} alt="" className="w-20 h-20 object-cover" />
          </a>
        ),
      )}
    </div>
  );
}
