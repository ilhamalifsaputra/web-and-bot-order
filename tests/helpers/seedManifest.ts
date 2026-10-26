/**
 * Invisible ownership record for the Game Top-up seed rows. Instead of putting
 * a visible marker in every name, the seed script stores the ids of every
 * category, product, denomination and buyer it created (or adopted) as JSON in
 * one settings row. The record lives only in the target database and holds no
 * secrets. Do not import this from product code.
 */
import { getSetting, setSetting, deleteSetting } from "@app/db";
import type { PrismaClient } from "@prisma/client";

export const SEED_MANIFEST_KEY = "seed_game_topup_manifest";

export type SeedRowKind = "categories" | "products" | "denominations" | "users";
const KINDS: readonly SeedRowKind[] = ["categories", "products", "denominations", "users"];

/** Thrown when the seed would have to take over (or collide with) a row it does not own. */
export class SeedConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedConflictError";
  }
}

export class SeedManifest {
  readonly ids: Record<SeedRowKind, Set<number>> = {
    categories: new Set(),
    products: new Set(),
    denominations: new Set(),
    users: new Set(),
  };

  static async load(db: PrismaClient): Promise<SeedManifest> {
    const manifest = new SeedManifest();
    // Read the row directly: getSetting caches for 30 s, and the manifest must always be current.
    const row = await db.setting.findUnique({ where: { key: SEED_MANIFEST_KEY } });
    if (!row) return manifest;
    const parsed = JSON.parse(row.value) as Partial<Record<SeedRowKind, number[]>>;
    for (const kind of KINDS) for (const id of parsed[kind] ?? []) manifest.ids[kind].add(id);
    return manifest;
  }

  has(kind: SeedRowKind, id: number): boolean {
    return this.ids[kind].has(id);
  }

  add(kind: SeedRowKind, id: number): void {
    this.ids[kind].add(id);
  }

  delete(kind: SeedRowKind, id: number): void {
    this.ids[kind].delete(id);
  }

  counts(): Record<SeedRowKind, number> {
    return {
      categories: this.ids.categories.size,
      products: this.ids.products.size,
      denominations: this.ids.denominations.size,
      users: this.ids.users.size,
    };
  }

  isEmpty(): boolean {
    return KINDS.every((k) => this.ids[k].size === 0);
  }

  /** Writes the record, or removes the settings row when nothing is left to track. */
  async save(db: PrismaClient): Promise<void> {
    if (this.isEmpty()) {
      await deleteSetting(db, SEED_MANIFEST_KEY);
      return;
    }
    const out: Record<string, number[]> = {};
    for (const kind of KINDS) out[kind] = [...this.ids[kind]].sort((a, b) => a - b);
    await setSetting(db, SEED_MANIFEST_KEY, JSON.stringify(out));
  }
}

/**
 * Find-or-create guard shared by both builders. With a manifest, an existing
 * row must already be listed in it; otherwise the seed refuses to touch it.
 * Without a manifest (the E2E test's empty database) any existing row is reused.
 */
export function guardExisting(manifest: SeedManifest | undefined, kind: SeedRowKind, id: number, what: string): void {
  if (!manifest || manifest.has(kind, id)) return;
  throw new SeedConflictError(
    `Refusing to adopt ${what}: it already exists in this database but was not created by this seed. Rename or remove it, or run against a database that does not have it.`,
  );
}
