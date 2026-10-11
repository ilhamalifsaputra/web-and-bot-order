import "@testing-library/jest-dom";
import { render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { FilePreview } from "./FilePreview";

afterEach(() => vi.unstubAllGlobals());
it("releases every created URL under Strict Mode, replacement, and unmount", () => {
  let nextUrl = 0;
  const createObjectURL = vi.fn(() => `blob:preview-${++nextUrl}`);
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  const first = new File(["first"], "first.png", { type: "image/png" });
  const second = new File(["second"], "second.png", { type: "image/png" });
  const { rerender, unmount, container } = render(<StrictMode><FilePreview file={first} /></StrictMode>);
  expect(createObjectURL).toHaveBeenCalledTimes(2);
  expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  rerender(<StrictMode><FilePreview file={second} /></StrictMode>);
  expect(createObjectURL).toHaveBeenCalledTimes(3);
  expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  expect(container.querySelector("img")).toHaveAttribute("src", "blob:preview-3");
  unmount();
  expect(revokeObjectURL).toHaveBeenCalledTimes(3);
  expect(revokeObjectURL.mock.calls.map(([url]) => url).sort()).toEqual(["blob:preview-1", "blob:preview-2", "blob:preview-3"]);
});
