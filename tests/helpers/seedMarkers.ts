import { expect } from "vitest";
import type { PrismaClient } from "@prisma/client";

/** Words that must never appear in anything a buyer or admin reads in the seeded catalog. */
const MARKER = /seed|fixture|test|dummy|n\/a/i;

/** Asserts no visible string of any category, product, denomination or user carries a seed marker. */
export async function expectNoVisibleMarkers(prisma: PrismaClient): Promise<void> {
  const bad: string[] = [];
  const check = (where: string, value: string | null | undefined) => {
    if (value && MARKER.test(value)) bad.push(`${where}: ${value}`);
  };
  for (const c of await prisma.category.findMany()) {
    check("category.name", c.name);
    check("category.slug", c.slug);
    check("category.description", c.description);
    check("category.emoji", c.emoji);
  }
  for (const p of await prisma.product.findMany()) {
    check("product.name", p.name);
    check("product.slug", p.slug);
    check("product.description", p.description);
    check("product.gameRegion", p.gameRegion);
    check("product.gameVariant", p.gameVariant);
  }
  for (const d of await prisma.denomination.findMany()) {
    check("denomination.name", d.name);
    check("denomination.slug", d.slug);
    check("denomination.durationLabel", d.durationLabel);
    check("denomination.description", d.description);
    check("denomination.qtyUnit", d.qtyUnit);
    check("denomination.supplierSku", d.supplierSku);
    check("denomination.additionalFields", d.additionalFields);
  }
  for (const u of await prisma.user.findMany()) {
    check("user.fullName", u.fullName);
    check("user.username", u.username);
  }
  expect(bad.slice(0, 10)).toEqual([]);
}
