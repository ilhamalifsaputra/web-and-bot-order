import { useEffect, useRef, useState } from "react";

interface FileRow {
  id: string;
  file: File;
}

/** Identity belongs to each staged File, including files with identical names
 * and metadata. Form payloads remain the caller's original File objects. */
export function useFileRows(files: File[]): Array<FileRow & { index: number }> {
  const previous = useRef<FileRow[]>([]);
  // Keys only need uniqueness within this staged list, including on HTTP.
  const nextId = useRef(0);
  const [rows, setRows] = useState<FileRow[]>([]);
  useEffect(() => {
    const remaining = [...previous.current];
    const next = files.map((file) => {
      const index = remaining.findIndex((row) => row.file === file);
      const existing = index >= 0 ? remaining.splice(index, 1)[0] : undefined;
      return {
        id: existing?.id ?? `file:${++nextId.current}`,
        file,
      };
    });
    previous.current = next;
    setRows(next);
  }, [files]);
  // Reused rows keep their File association and their preview component.
  // FilePreview owns the URL allocation and cleanup for each stable row.
  const available = [...rows];
  return files.flatMap((file, index) => {
    const match = available.findIndex((row) => row.file === file);
    return match < 0 ? [] : [{ ...available.splice(match, 1)[0]!, index }];
  });
}
