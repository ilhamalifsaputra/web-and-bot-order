import { useEffect } from "react";
import type { ReactNode } from "react";

export function PageLayout({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => {
    document.title = `${title} — Shop Admin`;
  }, [title]);
  return <>{children}</>;
}
