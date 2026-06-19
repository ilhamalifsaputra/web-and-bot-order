/**
 * Migration parity test for the catalog rename. Builds a fixture "old" DB
 * (pre-rename shape), runs the cutover, and asserts the plan's guarantees:
 * FK integrity, row-count parity, id preservation, orphans wrapped, no null
 * product_id/slug, and unique slugs. Covers BOTH old shapes — the full
 * db-push state (product_groups + product_group_id present) and the bare
 * 0_init state (neither present) — to exercise the defensive normalise step.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { migrateCatalogRename } from "./catalogRename";

// `node:sqlite` is too new for Vite's builtin externals list, so a static ESM
// import trips vite-node's resolver. Load it via createRequire (Node's resolver)
// to bypass the module graph; the type comes from a type-only import.
type DatabaseSync = import("node:sqlite").DatabaseSync;
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

type Row = Record<string, unknown>;
const n = (v: unknown) => Number(v);

/** Parent tables + dependent tables shared by both fixtures. */
function baseSchema(db: DatabaseSync, opts: { withGroups: boolean }) {
  db.exec(`CREATE TABLE "users" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT)`);
  db.exec(`CREATE TABLE "orders" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id"))`);
  db.exec(`CREATE TABLE "categories" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "emoji" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true)`);

  const groupCol = opts.withGroups ? `"product_group_id" INTEGER,` : "";
  const webImg = opts.withGroups ? `"web_image_url" TEXT,` : "";
  if (opts.withGroups) {
    db.exec(`CREATE TABLE "product_groups" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "category_id" INTEGER NOT NULL,
      "name" TEXT NOT NULL,
      "emoji" TEXT,
      "description" TEXT,
      "web_image_url" TEXT,
      "image_file_id" TEXT,
      "sort_order" INTEGER NOT NULL DEFAULT 0,
      "is_active" BOOLEAN NOT NULL DEFAULT true,
      "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  }
  db.exec(`CREATE TABLE "products" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "category_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "image_file_id" TEXT,
    ${webImg}
    "type" TEXT NOT NULL,
    "duration_label" TEXT NOT NULL,
    "price" DECIMAL NOT NULL,
    "reseller_price" DECIMAL,
    "warranty_days" INTEGER NOT NULL DEFAULT 30,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ${groupCol}
    CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE NO ACTION)`);
  db.exec(`CREATE TABLE "stock_items" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "product_id" INTEGER NOT NULL,
    "credentials" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "order_id" INTEGER,
    "added_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reserved_at" DATETIME, "sold_at" DATETIME, "note" TEXT,
    CONSTRAINT "stock_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "stock_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE NO ACTION)`);
  db.exec(`CREATE TABLE "order_items" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "order_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "stock_item_id" INTEGER,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_price" DECIMAL NOT NULL,
    "warranty_days_snapshot" INTEGER NOT NULL,
    CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "order_items_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "stock_items"("id") ON DELETE SET NULL ON UPDATE NO ACTION)`);
  db.exec(`CREATE TABLE "cart_items" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL, "product_id" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "added_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cart_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "cart_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    UNIQUE("user_id","product_id"))`);
  db.exec(`CREATE TABLE "reviews" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL, "product_id" INTEGER NOT NULL, "order_id" INTEGER NOT NULL,
    "rating" INTEGER NOT NULL, "comment" TEXT, "hidden" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "reviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "reviews_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "reviews_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION)`);
  db.exec(`CREATE TABLE "restock_subscriptions" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL, "product_id" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "restock_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "restock_subscriptions_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE NO ACTION)`);
  db.exec(`CREATE TABLE "bulk_pricing" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "product_id" INTEGER NOT NULL, "min_quantity" INTEGER NOT NULL,
    "discount_percent" DECIMAL NOT NULL, "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bulk_pricing_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE NO ACTION)`);
}

/**
 * Seed a small catalog. Returns the ids that the assertions key off. When
 * `withGroups`, one group holds two SKUs and one SKU is ungrouped; otherwise
 * every SKU is an orphan (all get wrapped).
 */
function seed(db: DatabaseSync, withGroups: boolean) {
  db.prepare(`INSERT INTO "users"("id","name") VALUES (1,'u')`).run();
  db.prepare(`INSERT INTO "orders"("id","user_id") VALUES (1,1)`).run();
  db.prepare(`INSERT INTO "categories"("id","name","emoji") VALUES (1,'Streaming','🎬')`).run();

  let groupId: number | null = null;
  if (withGroups) {
    db.prepare(`INSERT INTO "product_groups"("id","category_id","name") VALUES (1,1,'CapCut')`).run();
    groupId = 1;
  }
  const insSku = withGroups
    ? db.prepare(`INSERT INTO "products"("id","category_id","name","type","duration_label","price","warranty_days","product_group_id") VALUES (?,?,?,?,?,?,?,?)`)
    : db.prepare(`INSERT INTO "products"("id","category_id","name","type","duration_label","price","warranty_days") VALUES (?,?,?,?,?,?,?)`);

  // SKU ids 10, 11 grouped (when withGroups); 12 always ungrouped.
  if (withGroups) {
    insSku.run(10, 1, "CapCut 1 Month", "SHARED", "1 Month", "30", 30, groupId);
    insSku.run(11, 1, "CapCut 1 Week", "SHARED", "1 Week", "10", 30, groupId);
    insSku.run(12, 1, "Netflix 1 Month", "SHARED", "1 Month", "40", 30);
  } else {
    insSku.run(10, 1, "CapCut 1 Month", "SHARED", "1 Month", "30", 30);
    insSku.run(11, 1, "CapCut 1 Week", "SHARED", "1 Week", "10", 30);
    insSku.run(12, 1, "Netflix 1 Month", "SHARED", "1 Month", "40", 30);
  }

  // Dependent rows pinned to SKU 10 (so id preservation is observable).
  db.prepare(`INSERT INTO "stock_items"("id","product_id","credentials","status") VALUES (100,10,'a:b','SOLD')`).run();
  db.prepare(`INSERT INTO "order_items"("id","order_id","product_id","stock_item_id","quantity","unit_price","warranty_days_snapshot") VALUES (200,1,10,100,1,'30',30)`).run();
  db.prepare(`INSERT INTO "cart_items"("id","user_id","product_id","quantity") VALUES (300,1,11,2)`).run();
  db.prepare(`INSERT INTO "reviews"("id","user_id","product_id","order_id","rating") VALUES (400,1,10,1,5)`).run();
  db.prepare(`INSERT INTO "restock_subscriptions"("id","user_id","product_id") VALUES (500,1,12)`).run();
  db.prepare(`INSERT INTO "bulk_pricing"("id","product_id","min_quantity","discount_percent") VALUES (600,10,3,'10')`).run();
}

function runCase(withGroups: boolean) {
  const db = new DatabaseSync(":memory:");
  baseSchema(db, { withGroups });
  seed(db, withGroups);

  const oldSkuCount = n((db.prepare(`SELECT COUNT(*) c FROM "products"`).get() as Row).c);
  const oldGroupCount = withGroups ? n((db.prepare(`SELECT COUNT(*) c FROM "product_groups"`).get() as Row).c) : 0;
  const orphanCount = n((db.prepare(`SELECT COUNT(*) c FROM "products" WHERE ${withGroups ? "product_group_id IS NULL" : "1=1"}`).get() as Row).c);

  migrateCatalogRename(db); // throws on FK violation / null parent (the gate)

  return { db, oldSkuCount, oldGroupCount, orphanCount };
}

describe.each([
  { label: "full db-push old shape (product_groups present)", withGroups: true },
  { label: "bare 0_init old shape (no product_groups column/table)", withGroups: false },
])("catalog rename migration — $label", ({ withGroups }) => {
  it("preserves SKU ids as denominations and keeps row-count parity", () => {
    const { db, oldSkuCount, oldGroupCount, orphanCount } = runCase(withGroups);

    // denominations == old SKUs, ids preserved.
    expect(n((db.prepare(`SELECT COUNT(*) c FROM "denominations"`).get() as Row).c)).toBe(oldSkuCount);
    const d10 = db.prepare(`SELECT * FROM "denominations" WHERE id=10`).get() as Row;
    expect(d10).toBeTruthy();
    expect(d10.name).toBe("CapCut 1 Month");

    // products == groups + one wrapper per orphan SKU.
    expect(n((db.prepare(`SELECT COUNT(*) c FROM "products"`).get() as Row).c)).toBe(oldGroupCount + orphanCount);
  });

  it("gives every orphan SKU a 1:1 wrapper product in the same category", () => {
    const { db } = runCase(withGroups);
    // SKU 12 is always ungrouped → must have its own parent product (not a group).
    const d12 = db.prepare(`SELECT * FROM "denominations" WHERE id=12`).get() as Row;
    const parent = db.prepare(`SELECT * FROM "products" WHERE id=?`).get(n(d12.product_id)) as Row;
    expect(parent).toBeTruthy();
    expect(parent.category_id).toBe(1);
    expect(parent.name).toBe("Netflix 1 Month");
  });

  it("retargets dependent FKs to denominations with ids unchanged + clean FK check", () => {
    const { db } = runCase(withGroups);
    expect((db.prepare("PRAGMA foreign_key_check").all() as Row[]).length).toBe(0);
    // product_id columns are preserved (same denomination ids).
    expect(n((db.prepare(`SELECT product_id FROM "stock_items" WHERE id=100`).get() as Row).product_id)).toBe(10);
    expect(n((db.prepare(`SELECT product_id FROM "order_items" WHERE id=200`).get() as Row).product_id)).toBe(10);
    expect(n((db.prepare(`SELECT product_id FROM "bulk_pricing" WHERE id=600`).get() as Row).product_id)).toBe(10);
    // dependent rows still reference real denominations.
    expect(db.prepare(`SELECT 1 FROM "denominations" WHERE id=(SELECT product_id FROM "cart_items" WHERE id=300)`).get()).toBeTruthy();
  });

  it("backfills non-null unique slugs on categories, products and denominations", () => {
    const { db } = runCase(withGroups);
    for (const t of ["categories", "products", "denominations"]) {
      const nulls = n((db.prepare(`SELECT COUNT(*) c FROM "${t}" WHERE slug IS NULL OR slug=''`).get() as Row).c);
      expect(nulls).toBe(0);
      const total = n((db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get() as Row).c);
      const distinct = n((db.prepare(`SELECT COUNT(DISTINCT slug) c FROM "${t}"`).get() as Row).c);
      expect(distinct).toBe(total); // unique
    }
  });

  it("links grouped SKUs to their original group as the parent product", () => {
    const { db } = runCase(withGroups);
    const d10 = db.prepare(`SELECT product_id FROM "denominations" WHERE id=10`).get() as Row;
    if (withGroups) {
      expect(n(d10.product_id)).toBe(1); // old group id 1 preserved as product id
    } else {
      // no groups → SKU 10 also gets a wrapper (its own parent, not shared with 11)
      const d11 = db.prepare(`SELECT product_id FROM "denominations" WHERE id=11`).get() as Row;
      expect(n(d10.product_id)).not.toBe(n(d11.product_id));
    }
  });
});
