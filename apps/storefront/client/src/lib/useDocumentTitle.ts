import { useEffect } from "react";

/**
 * Sets `document.title` whenever `title` changes. `undefined`/`null`/"" means
 * "nothing to say yet" (e.g. the shop name or the fetched entity hasn't
 * loaded) — the hook leaves whatever title is already on the tab alone rather
 * than blanking it, so a slow product/category fetch never shows an empty or
 * wrong-looking tab title while it's pending.
 */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    if (title) document.title = title;
  }, [title]);
}
