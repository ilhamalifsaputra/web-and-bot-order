// Backend audit Task C4 — safeNext, the storefront's open-redirect guard for
// `?next=` after login/register. Browsers treat a backslash in a URL like a
// forward slash and silently drop tab/newline characters, so `/\evil.com`
// or `/<TAB>/evil.com` both become the protocol-relative `//evil.com` — an
// off-site redirect — even though the raw string starts with a single "/".
import "./setup-env"; // FIRST import — sets env before @app/* load
import { describe, expect, it } from "vitest";
import { safeNext } from "../src/routes/auth";

describe("safeNext", () => {
  it("keeps ordinary local paths", () => {
    expect(safeNext("/")).toBe("/");
    expect(safeNext("/account/orders")).toBe("/account/orders");
    expect(safeNext("/p/some-product?ref=ABC#top")).toBe("/p/some-product?ref=ABC#top");
    expect(safeNext("/%5Cnot-a-host")).toBe("/%5Cnot-a-host"); // encoded: stays a path
  });

  it("refuses protocol-relative and absolute URLs", () => {
    expect(safeNext("//evil.com")).toBe("/");
    expect(safeNext("https://evil.com")).toBe("/");
    expect(safeNext("evil.com")).toBe("/");
    expect(safeNext(undefined)).toBe("/");
    expect(safeNext(42)).toBe("/");
  });

  it("refuses backslash tricks that browsers read as //host", () => {
    expect(safeNext("/\\evil.com")).toBe("/");
    expect(safeNext("\\\\evil.com")).toBe("/");
    expect(safeNext("/\\/evil.com")).toBe("/");
    expect(safeNext("/account\\..\\x")).toBe("/");
  });

  it("refuses control characters browsers strip out of URLs", () => {
    expect(safeNext("/\t/evil.com")).toBe("/");
    expect(safeNext("/\n/evil.com")).toBe("/");
    expect(safeNext("/\r/evil.com")).toBe("/");
  });
});
