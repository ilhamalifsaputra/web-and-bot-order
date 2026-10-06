import { prisma } from "@app/db";
import { backfillPlayerInputConfiguration } from "../packages/db/src/crud/playerInputBackfill";

async function main() {
  const apply = process.argv.includes("--apply");
  const productsArg = process.argv.find((arg) => arg.startsWith("--product-ids="));
  const productIds = productsArg ? productsArg.split("=")[1]!.split(",").map(Number) : undefined;
  if (productIds?.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error("Invalid product ids");
  try {
    const changes = await prisma.$transaction((tx) => backfillPlayerInputConfiguration(tx, { apply, productIds }), { timeout: 60_000 });
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", changes }, null, 2));
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : "Backfill failed"); process.exitCode = 1; });
