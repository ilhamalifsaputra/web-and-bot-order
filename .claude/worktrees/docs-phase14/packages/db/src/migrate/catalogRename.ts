/**
 * Catalog rename cutover: Category → (old) Product → (old) ProductGroup  ⇒
 * Category → Product (mid-tier, was product_groups) → Denomination (SKU, was
 * products). Data-preserving; ids of old `products` are preserved as
 * `denominations.id` so every dependent `product_id` FK keeps pointing at the
 * same rows.
 *
 * Operates on a `node:sqlite` DatabaseSync so we get real PRAGMA + transaction
 * control (Prisma can't toggle `foreign_keys` mid-transaction). Used by the
 * deploy script (`scripts/migrate-catalog-rename.ts`) and the parity test.
 *
 * DEFENSIVE (plan step 0): the live DB's exact shape is uncertain — the
 * `product_groups` table and `products.product_group_id` / `products.web_image_url`
 * columns were applied via `db push`, not a tracked migration, so they may or may
 * not exist. We normalise the old shape first. The normalise step is the one
 * non-idempotent spot: run the whole cutover exactly once, against a backup.
 */
import type { DatabaseSync } from "node:sqlite";
import { uniqueSlug } from "./slug";

/** The value types node:sqlite can bind / returns. */
type Cell = null | number | bigint | string | Uint8Array;
type Row = Record<string, Cell>;

/** Coerce bound params (Record access is `Cell | undefined` under
 * noUncheckedIndexedAccess) to the SQLInputValue list `.run()` accepts. */
const b = (...vals: Array<Cell | undefined>): Cell[] => vals.map((v) => v ?? null);

function hasTable(db: DatabaseSync, name: string): boolean {
  const r = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return r != null;
}
function hasColumn(db: DatabaseSync, table: string, col: string): boolean {
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as Row[];
  return cols.some((c) => c.name === col);
}

// --- Target DDL (mirrors the canonical Prisma schema; index NAMES may differ
// from db-push's reserved `sqlite_autoindex_*`, which is irrelevant to FK
// integrity + data parity). Business UNIQUEs are inline so the engine creates
// them. ----------------------------------------------------------------------
const DDL_PRODUCTS = `CREATE TABLE "products" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "category_id" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "emoji" TEXT,
  "description" TEXT,
  "web_image_url" TEXT,
  "image_file_id" TEXT,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
)`;

const DDL_DENOMINATIONS = `CREATE TABLE "denominations" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "product_id" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "description" TEXT,
  "image_file_id" TEXT,
  "web_image_url" TEXT,
  "type" TEXT NOT NULL,
  "duration_label" TEXT NOT NULL,
  "price" DECIMAL NOT NULL,
  "cost_price" DECIMAL,
  "reseller_price" DECIMAL,
  "auto_delivery_source" TEXT,
  "warranty_days" INTEGER NOT NULL DEFAULT 30,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "denominations_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
)`;

const DDL_CATEGORIES_NEW = `CREATE TABLE "categories_new" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "emoji" TEXT,
  "description" TEXT,
  "image" TEXT,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  UNIQUE("name")
)`;

// Dependent tables, rebuilt with the product_id FK retargeted to denominations.
const DEP_DDL: Record<string, string> = {
  stock_items: `CREATE TABLE "stock_items_new" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "product_id" INTEGER NOT NULL,
    "credentials" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "order_id" INTEGER,
    "added_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reserved_at" DATETIME,
    "sold_at" DATETIME,
    "note" TEXT,
    CONSTRAINT "stock_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "denominations"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "stock_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE NO ACTION
  )`,
  order_items: `CREATE TABLE "order_items_new" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "order_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "stock_item_id" INTEGER,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_price" DECIMAL NOT NULL,
    "warranty_days_snapshot" INTEGER NOT NULL,
    CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "denominations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "order_items_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "stock_items"("id") ON DELETE SET NULL ON UPDATE NO ACTION
  )`,
  cart_items: `CREATE TABLE "cart_items_new" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "added_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cart_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "cart_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "denominations"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    UNIQUE("user_id","product_id")
  )`,
  reviews: `CREATE TABLE "reviews_new" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "order_id" INTEGER NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "reviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "reviews_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "denominations"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "reviews_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    UNIQUE("user_id","order_id")
  )`,
  restock_subscriptions: `CREATE TABLE "restock_subscriptions_new" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "restock_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "restock_subscriptions_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "denominations"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    UNIQUE("user_id","product_id")
  )`,
  bulk_pricing: `CREATE TABLE "bulk_pricing_new" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "product_id" INTEGER NOT NULL,
    "min_quantity" INTEGER NOT NULL,
    "discount_percent" DECIMAL NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bulk_pricing_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "denominations"("id") ON DELETE CASCADE ON UPDATE NO ACTION
  )`,
};
const DEP_COLUMNS: Record<string, string> = {
  stock_items: "id,product_id,credentials,status,order_id,added_at,reserved_at,sold_at,note",
  order_items: "id,order_id,product_id,stock_item_id,quantity,unit_price,warranty_days_snapshot",
  cart_items: "id,user_id,product_id,quantity,added_at",
  reviews: "id,user_id,product_id,order_id,rating,comment,hidden,created_at",
  restock_subscriptions: "id,user_id,product_id,created_at",
  bulk_pricing: "id,product_id,min_quantity,discount_percent,is_active,created_at",
};

const POST_INDEXES = [
  `CREATE UNIQUE INDEX "ix_categories_slug" ON "categories"("slug")`,
  `CREATE UNIQUE INDEX "ix_products_slug" ON "products"("slug")`,
  `CREATE INDEX "ix_products_category_id" ON "products"("category_id")`,
  `CREATE UNIQUE INDEX "ix_denominations_slug" ON "denominations"("slug")`,
  `CREATE INDEX "ix_denominations_product_id" ON "denominations"("product_id")`,
  `CREATE INDEX "ix_stock_items_status" ON "stock_items"("status")`,
  `CREATE INDEX "ix_stock_items_product_id" ON "stock_items"("product_id")`,
  `CREATE INDEX "ix_stock_product_status" ON "stock_items"("product_id","status")`,
  `CREATE INDEX "ix_order_items_order_id" ON "order_items"("order_id")`,
  `CREATE INDEX "ix_cart_items_user_id" ON "cart_items"("user_id")`,
  `CREATE INDEX "ix_reviews_product_id" ON "reviews"("product_id")`,
  `CREATE UNIQUE INDEX "ix_bulk_pricing_product_id" ON "bulk_pricing"("product_id")`,
];

/** Run the full catalog rename cutover in one transaction. Throws on any FK
 * violation left behind (the integrity gate). */
export function migrateCatalogRename(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    // --- Step 0: normalise the uncertain old shape -------------------------
    if (!hasColumn(db, "products", "product_group_id")) {
      db.exec(`ALTER TABLE "products" ADD COLUMN "product_group_id" INTEGER`);
    }
    if (!hasColumn(db, "products", "web_image_url")) {
      db.exec(`ALTER TABLE "products" ADD COLUMN "web_image_url" TEXT`);
    }
    if (!hasTable(db, "product_groups")) {
      db.exec(`CREATE TABLE "product_groups" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "category_id" INTEGER NOT NULL,
        "name" TEXT NOT NULL,
        "emoji" TEXT,
        "description" TEXT,
        "web_image_url" TEXT,
        "image_file_id" TEXT,
        "sort_order" INTEGER NOT NULL DEFAULT 0,
        "is_active" BOOLEAN NOT NULL DEFAULT true,
        "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
    }

    // --- Read old rows (free the `products`/`product_groups` names after) ---
    db.exec(`ALTER TABLE "products" RENAME TO "products_old"`);
    db.exec(`ALTER TABLE "product_groups" RENAME TO "product_groups_old"`);

    const oldGroups = db.prepare(`SELECT * FROM "product_groups_old"`).all() as Row[];
    const oldSkus = db.prepare(`SELECT * FROM "products_old"`).all() as Row[];

    // --- Compute slugs (one pass, deduped per-tier) ------------------------
    const catTaken = new Set<string>();
    const prodTaken = new Set<string>();
    const denomTaken = new Set<string>();

    // --- Step 2: new mid-tier `products` from product_groups (id preserved) -
    db.exec(DDL_PRODUCTS);
    const insProduct = db.prepare(
      `INSERT INTO "products"
        ("id","category_id","name","slug","emoji","description","web_image_url","image_file_id","sort_order","is_active","created_at")
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const g of oldGroups) {
      const slug = uniqueSlug(String(g.name), Number(g.id), prodTaken);
      insProduct.run(
        ...b(g.id, g.category_id, g.name, slug, g.emoji ?? null, g.description ?? null,
          g.web_image_url ?? null, g.image_file_id ?? null, g.sort_order ?? 0, g.is_active ?? 1, g.created_at),
      );
    }

    // --- Step 3: 1:1 wrapper Product per orphan SKU (mandatory parent) ------
    const insWrapper = db.prepare(
      `INSERT INTO "products"
        ("category_id","name","slug","emoji","description","web_image_url","image_file_id","sort_order","is_active","created_at")
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    const wrapperFor = new Map<number, number>(); // old SKU id → new wrapper product id
    for (const s of oldSkus) {
      if (s.product_group_id != null) continue; // grouped → parent already exists
      const slug = uniqueSlug(String(s.name), Number(s.id), prodTaken);
      const res = insWrapper.run(
        ...b(s.category_id, s.name, slug, null, s.description ?? null,
          s.web_image_url ?? null, s.image_file_id ?? null, 0, s.is_active ?? 1, s.created_at),
      );
      wrapperFor.set(Number(s.id), Number(res.lastInsertRowid));
    }

    // --- Step 1+: `denominations` from old products (id preserved) ----------
    db.exec(DDL_DENOMINATIONS);
    const insDenom = db.prepare(
      `INSERT INTO "denominations"
        ("id","product_id","name","slug","description","image_file_id","web_image_url","type","duration_label",
         "price","cost_price","reseller_price","auto_delivery_source","warranty_days","sort_order","is_active","created_at")
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const s of oldSkus) {
      const productId = s.product_group_id != null ? Number(s.product_group_id) : wrapperFor.get(Number(s.id))!;
      const slug = uniqueSlug(String(s.name), Number(s.id), denomTaken);
      insDenom.run(
        ...b(s.id, productId, s.name, slug, s.description ?? null, s.image_file_id ?? null, s.web_image_url ?? null,
          s.type, s.duration_label, s.price, null, s.reseller_price ?? null, null,
          s.warranty_days ?? 30, 0, s.is_active ?? 1, s.created_at),
      );
    }

    // --- Step 5a: rebuild `categories` (add slug/description/image) ---------
    db.exec(DDL_CATEGORIES_NEW);
    const oldCats = db.prepare(`SELECT * FROM "categories"`).all() as Row[];
    const insCat = db.prepare(
      `INSERT INTO "categories_new" ("id","name","slug","emoji","description","image","sort_order","is_active")
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    for (const c of oldCats) {
      const slug = uniqueSlug(String(c.name), Number(c.id), catTaken);
      insCat.run(...b(c.id, c.name, slug, c.emoji ?? null, null, null, c.sort_order ?? 0, c.is_active ?? 1));
    }
    db.exec(`DROP TABLE "categories"`);
    db.exec(`ALTER TABLE "categories_new" RENAME TO "categories"`);

    // --- Step 4: retarget dependent FKs to denominations (table rebuild) ----
    for (const [table, ddl] of Object.entries(DEP_DDL)) {
      const cols = DEP_COLUMNS[table]!;
      db.exec(ddl);
      db.exec(`INSERT INTO "${table}_new" (${cols}) SELECT ${cols} FROM "${table}"`);
      db.exec(`DROP TABLE "${table}"`);
      db.exec(`ALTER TABLE "${table}_new" RENAME TO "${table}"`);
    }

    // --- Step 6: drop the old source tables ---------------------------------
    db.exec(`DROP TABLE "products_old"`);
    db.exec(`DROP TABLE "product_groups_old"`);

    // --- Step 5b: indices ---------------------------------------------------
    for (const sql of POST_INDEXES) db.exec(sql);

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    db.exec("PRAGMA foreign_keys = ON");
    throw err;
  }
  db.exec("PRAGMA foreign_keys = ON");

  // --- Step 7: integrity gate --------------------------------------------
  const violations = db.prepare("PRAGMA foreign_key_check").all() as Row[];
  if (violations.length > 0) {
    throw new Error(`catalog rename left ${violations.length} FK violation(s): ${JSON.stringify(violations.slice(0, 5))}`);
  }
  const nullParents = db.prepare(`SELECT COUNT(*) AS n FROM "denominations" WHERE "product_id" IS NULL`).get() as Row;
  if (Number(nullParents.n) > 0) throw new Error(`${nullParents.n} denomination(s) with null product_id`);
}
