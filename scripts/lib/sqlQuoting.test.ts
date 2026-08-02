import { describe, expect, it } from "vitest";
import { findUnqualifiedSources, sanitizeSql, scanMigrationSql } from "./sqlQuoting";

describe("sanitizeSql", () => {
  it("strips a line comment", () => {
    expect(sanitizeSql('SELECT 1 -- trailing comment\nFROM x')).toBe(
      "SELECT 1 \nFROM x",
    );
  });

  it("strips a block comment", () => {
    expect(sanitizeSql("SELECT /* mid */ 1 FROM x")).toBe("SELECT  1 FROM x");
  });

  it("does not treat -- inside a string literal as a comment (false negative fix)", () => {
    // Before the rewrite, this deleted everything from the `--` to end of
    // line — including the closing quote — leaving the rest of the
    // statement (and its FROM clause) unbalanced/invisible to the scanner.
    const sql = `UPDATE "orders" SET "note" = 'has -- dashes' WHERE "id" = 1;`;
    expect(sanitizeSql(sql)).toBe(sql);
  });

  it("does not treat /* inside a string literal as a comment start", () => {
    const sql = `SELECT 'a /* not a comment */ b' FROM "orders"`;
    expect(sanitizeSql(sql)).toBe(sql);
  });

  it("masks a double-quoted word inside a string literal (false positive fix)", () => {
    const sanitized = sanitizeSql(`SELECT 'say "hi"' FROM "orders"`);
    // The embedded "hi" must no longer look like a quoted identifier.
    expect(sanitized).not.toContain('"hi"');
    // But the real identifier "orders" must be untouched.
    expect(sanitized).toContain('"orders"');
  });

  it("honours doubled-quote escapes inside string literals", () => {
    const sql = `SELECT 'it''s fine' FROM "orders"`;
    expect(sanitizeSql(sql)).toContain('"orders"');
  });

  it("leaves an already-clean statement unchanged", () => {
    const sql = `SELECT "orders"."id" FROM "orders" WHERE "orders"."status" = 'PAID'`;
    expect(sanitizeSql(sql)).toBe(sql);
  });
});

describe("findUnqualifiedSources", () => {
  it("flags a bare column in a select list", () => {
    expect(findUnqualifiedSources('"status"')).toEqual(["status"]);
  });

  it("passes a fully table-qualified column", () => {
    expect(findUnqualifiedSources('"orders"."status"')).toEqual([]);
  });

  it("flags a bare column in a WHERE-shaped fragment", () => {
    // This is the headline fix: previously only the text between SELECT and
    // the first FROM was ever inspected, so a bare reference living in a
    // WHERE clause (the realistic spot for a correlated backfill's hazard)
    // was invisible to the guard.
    expect(findUnqualifiedSources('WHERE "status" = \'PAID\'')).toEqual([
      "status",
    ]);
  });

  it("does not flag a qualified column referenced in a WHERE-shaped fragment", () => {
    expect(
      findUnqualifiedSources('WHERE "orders"."status" = \'PAID\''),
    ).toEqual([]);
  });

  it("does not flag a column immediately after AND/OR/ON keywords as an alias", () => {
    // Regression guard for the keyword-adjacency trap: a naive "preceded by
    // a word => it's an alias" rule would wrongly exempt these.
    expect(
      findUnqualifiedSources('"t"."a" = 1 AND "status" = \'PAID\''),
    ).toEqual(["status"]);
    expect(findUnqualifiedSources('"a"."x" = "b"."y" ON "flag"')).toEqual([
      "flag",
    ]);
  });

  it("exempts the explicit AS alias form", () => {
    expect(
      findUnqualifiedSources('"orders"."status" AS "status"'),
    ).toEqual([]);
  });

  it("exempts the implicit alias form (no AS keyword)", () => {
    expect(findUnqualifiedSources('"orders"."status" "status"')).toEqual([]);
  });

  it("does not let the implicit-alias exemption swallow a second bare column", () => {
    // "b" is a new select-list item after a comma, not an alias of "a".
    expect(findUnqualifiedSources('"a", "b"')).toEqual(["a", "b"]);
  });

  it("exempts a table name immediately after JOIN", () => {
    expect(
      findUnqualifiedSources('JOIN "orders" ON "orders"."id" = "x"."order_id"'),
    ).toEqual([]);
  });
});

describe("scanMigrationSql", () => {
  it("flags a bare column in a rebuild copy's select list", () => {
    const sql = `INSERT INTO "new_orders" ("id","status") SELECT "id", "status" FROM "orders";`;
    const refs = scanMigrationSql(sql);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      kind: "rebuild",
      table: "orders",
      unqualifiedColumns: ["id", "status"],
    });
  });

  it("passes a rebuild copy whose columns are all table-qualified", () => {
    const sql = `INSERT INTO "new_orders" ("id","status") SELECT "orders"."id", "orders"."status" FROM "orders";`;
    const refs = scanMigrationSql(sql);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.unqualifiedColumns).toEqual([]);
  });

  it("flags a bare column read inside a correlated subquery's WHERE clause", () => {
    // The real-world shape this guard is named for: a bare reference in the
    // select list AND the WHERE both need catching, and pre-widening this
    // guard only ever looked at the select list.
    const sql = `
      UPDATE "order_items"
      SET "delivery_type_snapshot" = (
        SELECT "delivery_type" FROM "denominations" WHERE "id" = "order_items"."product_id"
      )
      WHERE "delivery_type_snapshot" IS NULL;
    `;
    const refs = scanMigrationSql(sql);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ kind: "subquery", table: "denominations" });
    // Both the select-list "delivery_type" and the WHERE's bare "id" (which
    // resolves against denominations, the subquery's own FROM table) must be
    // caught.
    expect(refs[0]?.unqualifiedColumns).toEqual(
      expect.arrayContaining(["delivery_type", "id"]),
    );
  });

  it("passes the real fixed shape of the historical H-9 migration", () => {
    const sql = `
      UPDATE "order_items"
      SET "delivery_type_snapshot" = (
        SELECT "denominations"."delivery_type" FROM "denominations" WHERE "denominations"."id" = "order_items"."product_id"
      )
      WHERE "delivery_type_snapshot" IS NULL;
    `;
    const refs = scanMigrationSql(sql);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.unqualifiedColumns).toEqual([]);
  });

  it("still inspects a subquery whose source table is unquoted", () => {
    // Previously both regexes required `FROM "quoted_table"` with literal
    // quotes; an unquoted `FROM orders` matched neither, so the whole
    // statement went uninspected.
    const sql = `SELECT "status" FROM orders WHERE "id" = 1;`;
    const refs = scanMigrationSql(sql);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ table: "orders" });
    expect(refs[0]?.unqualifiedColumns).toEqual(
      expect.arrayContaining(["status", "id"]),
    );
  });

  it("still inspects an unquoted table name in a rebuild copy", () => {
    const sql = `INSERT INTO "new_orders" ("id") SELECT "id" FROM orders;`;
    const refs = scanMigrationSql(sql);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ kind: "rebuild", table: "orders" });
    expect(refs[0]?.unqualifiedColumns).toEqual(["id"]);
  });

  it("does not double-count a rebuild copy's own SELECT as a separate subquery", () => {
    const sql = `INSERT INTO "new_orders" ("id","status") SELECT "orders"."id", "orders"."status" FROM "orders";`;
    const refs = scanMigrationSql(sql);
    expect(refs.filter((r) => r.kind === "subquery")).toHaveLength(0);
  });

  it("a -- inside a string literal does not blind the scan to a real hazard later in the file", () => {
    const sql = `
      UPDATE "orders" SET "note" = 'has -- dashes' WHERE "id" = 1;
      INSERT INTO "new_orders" ("id","status") SELECT "id", "status" FROM "orders";
    `;
    const refs = scanMigrationSql(sql);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.unqualifiedColumns).toEqual(["id", "status"]);
  });

  it("a double-quoted word inside a string literal does not false-positive as a bare column", () => {
    const sql = `SELECT "src"."id", 'say "hi"' FROM "src";`;
    const refs = scanMigrationSql(sql);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.unqualifiedColumns).toEqual([]);
  });

  it("does not flag either alias form end to end", () => {
    const sql = `SELECT "src"."a" AS "alias_a", "src"."b" "alias_b" FROM "src";`;
    const refs = scanMigrationSql(sql);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.unqualifiedColumns).toEqual([]);
  });
});
