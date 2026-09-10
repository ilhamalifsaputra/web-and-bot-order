/**
 * AC-11: the 5 "Game A ..." synthetic catalog variants (never referenced
 * anywhere else in the engine or knowledge files — see
 * `__fixtures__/syntheticGameA.ts`) each resolve to a distinct, resolved
 * productKey when run through the real `detect()` pipeline against a
 * catalog built purely from `buildCatalogIndex` + `DEFAULT_KNOWLEDGE_BASE`-
 * derived knowledge. This proves the engine generalizes to catalog data it
 * was never tuned against, not just the fixtures used to develop it.
 */

import { describe, it, expect } from "vitest";
import { detect, type DetectionDeps } from "./engine";
import { buildCatalogIndex } from "./indexBuild";
import { SYNTHETIC_CATALOG, SYNTHETIC_KNOWLEDGE } from "./__fixtures__/syntheticGameA";

const INDEX = buildCatalogIndex(SYNTHETIC_CATALOG, SYNTHETIC_KNOWLEDGE, "synthetic-gameA-stamp");
const DEPS: DetectionDeps = { knowledge: SYNTHETIC_KNOWLEDGE, index: INDEX, supplier: "digiflazz" };

// Paired with each fixture row's own externalId — see the module doc
// comment in engine.acceptance.test.ts for why a bare productName-only
// query is not sufficient here (these five rows deliberately share a
// baseProductKey, "game a").
const GAME_A_VARIANTS: { productName: string; externalId: string }[] = [
  { productName: "Game A", externalId: "EXT-GAMEA-BASE" },
  { productName: "Game A Mobile", externalId: "EXT-GAMEA-MOBILE" },
  { productName: "Game A Global", externalId: "EXT-GAMEA-GLOBAL" },
  { productName: "Game A Garena", externalId: "EXT-GAMEA-GARENA" },
  { productName: "Game A PC", externalId: "EXT-GAMEA-PC" },
];

describe("detect() — AC-11 synthetic Game A catalog", () => {
  it("resolves each of the 5 Game A variants to a distinct, resolved productKey", () => {
    const productKeys = new Set<string>();
    for (const variant of GAME_A_VARIANTS) {
      const result = detect(variant, DEPS);
      expect(result.status).toBe("resolved");
      if (result.status !== "resolved") continue;
      productKeys.add(result.productKey);
    }
    expect(productKeys.size).toBe(5);
  });

  it.each(GAME_A_VARIANTS)("resolves $productName individually with status resolved", (variant) => {
    const result = detect(variant, DEPS);
    expect(result.status).toBe("resolved");
  });
});
