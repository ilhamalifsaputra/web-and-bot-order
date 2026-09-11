import { describe, it, expect } from "vitest";
import { cn } from "./cn";

describe("cn", () => {
  it("joins truthy strings with a single space", () => {
    expect(cn("btn", "btn-primary")).toBe("btn btn-primary");
  });

  it("drops false / null / undefined so no stray spaces or literals leak", () => {
    expect(cn("btn", false, null, undefined, "btn-sm")).toBe("btn btn-sm");
  });

  it("returns an empty string when nothing is truthy", () => {
    expect(cn(false, undefined)).toBe("");
  });

  it("keeps caller order (last wins by source order downstream)", () => {
    expect(cn("field", "border-rust", "custom")).toBe("field border-rust custom");
  });
});
