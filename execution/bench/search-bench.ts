/**
 * Perf bench for the catalog read paths (execution/05, M-2 / M-3).
 *
 * Spins an isolated SQLite DB (never touches data/bot.db), seeds a synthetic
 * catalog, and times the three storefront read paths over many iterations,
 * reporting p50/p95. Used to (a) confirm M-2's DB-level cap and (b) decide
 * whether M-3 (a catalog read cache) is justified by real numbers.
 *
 *   pnpm exec tsx execution/bench/search-bench.ts [products] [iterations]
 *   # defaults: 5000 products, 200 iterations
 */
import { makeTestDb } from "../../tests/helpers/testdb";
import {
  listCatalogEntries,
  listNewestCatalogEntries,
  searchCatalogEntries,
  createGroup,
  assignProductToGroup,
} from "../../packages/db/src/crud/catalog";

const PRODUCTS = Number(process.argv[2] ?? 5000);
const ITERS = Number(process.argv[3] ?? 200);

function pct(sortedMs: number[], p: number): number {
  const i = Math.min(sortedMs.length - 1, Math.floor((p / 100) * sortedMs.length));
  return sortedMs[i]!;
}

async function time(label: string, fn: () => Promise<unknown>): Promise<void> {
  await fn(); // warm-up
  const samples: number[] = [];
  for (let i = 0; i < ITERS; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((s, x) => s + x, 0) / samples.length;
  console.log(
    `${label.padEnd(28)} p50=${pct(samples, 50).toFixed(2)}ms  ` +
      `p95=${pct(samples, 95).toFixed(2)}ms  mean=${mean.toFixed(2)}ms`,
  );
}

async function main(): Promise<void> {
  console.log(`Seeding ${PRODUCTS} products …`);
  const db = await makeTestDb();
  const { prisma } = db;
  try {
    const cat = await prisma.category.create({ data: { name: "Bench" } });
    // ~10% of products live in groups of 5 to exercise the collapse/group path.
    const groupCount = Math.floor((PRODUCTS * 0.1) / 5);
    const groups: number[] = [];
    for (let g = 0; g < groupCount; g++) {
      const grp = await createGroup(prisma, { categoryId: cat.id, name: `BenchGroup ${String(g).padStart(5, "0")}` });
      groups.push(grp.id);
    }
    await prisma.product.createMany({
      data: Array.from({ length: PRODUCTS }, (_, i) => ({
        categoryId: cat.id,
        name: `BenchItem ${String(i).padStart(6, "0")}`,
        type: "SHARED" as const,
        durationLabel: "1 Month",
        price: "5",
      })),
    });
    // Assign the first groupCount*5 products into the groups.
    const all = await prisma.product.findMany({ where: { categoryId: cat.id }, orderBy: { id: "asc" }, take: groupCount * 5 });
    for (let i = 0; i < all.length; i++) {
      await assignProductToGroup(prisma, all[i]!.id, groups[Math.floor(i / 5)]!);
    }

    console.log(`Timing over ${ITERS} iterations …\n`);
    await time("searchCatalogEntries('a')", () => searchCatalogEntries(prisma, "a", 24));
    await time("listNewestCatalogEntries(12)", () => listNewestCatalogEntries(prisma, 12));
    await time("listCatalogEntries(category)", () => listCatalogEntries(prisma, cat.id));
  } finally {
    await db.cleanup();
  }
}

void main();
