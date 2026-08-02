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

  it("exempts a table name immediately after a nested FROM", () => {
    // A second, nested FROM (a correlated `IN (SELECT ... FROM "t")`
    // subquery, or a UNION arm) names a source table, not a column read —
    // mirrors the JOIN exemption above.
    expect(
      findUnqualifiedSources('IN (SELECT "users"."id" FROM "users")'),
    ).toEqual([]);
  });

  it("still flags a bare column inside a nested FROM's own select list", () => {
    // The FROM exemption above must be scoped to the table-name position
    // only — a genuine bare column in the nested subquery's select list
    // (here "id", which is not table-qualified) still has to be caught.
    expect(
      findUnqualifiedSources('IN (SELECT "id" FROM "users")'),
    ).toEqual(["id"]);
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

  it("does not misread a nested IN (SELECT ... FROM) subquery's table name as a bare column (false positive fix)", () => {
    // Before the FROM exemption, widening the inspected region to
    // end-of-statement (weakness 3) meant this nested subquery's `FROM
    // "users"` landed in the tail scan and "users" was misreported as an
    // unqualified column, even though every real column here is
    // table-qualified.
    const sql = `INSERT INTO "new_orders" ("id") SELECT "orders"."id" FROM "orders"
      WHERE "orders"."user_id" IN (SELECT "users"."id" FROM "users" WHERE "users"."banned" = 0);`;
    const refs = scanMigrationSql(sql);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ kind: "rebuild", table: "orders" });
    expect(refs[0]?.unqualifiedColumns).toEqual([]);
  });

  it("does not misread a UNION ALL second arm's table name as a bare column (false positive fix)", () => {
    // Same root cause as above: the tail scan now reaches the second
    // SELECT's `FROM "b"`, whose table name must not be flagged as a bare
    // column when every real column is qualified.
    const sql = `INSERT INTO "new_x" ("v") SELECT "a"."x" FROM "a" UNION ALL SELECT "b"."x" FROM "b";`;
    const refs = scanMigrationSql(sql);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ kind: "rebuild", table: "a" });
    expect(refs[0]?.unqualifiedColumns).toEqual([]);
  });

  it("still flags a bare column inside a nested subquery's select list (proves the FROM exemption is scoped to the table position only)", () => {
    // Distinguishes "exempt the FROM target" from "exempt everything past a
    // FROM": "users" (the nested subquery's table) must be exempt, but "id"
    // (a genuine bare column in that same nested subquery's select list)
    // must still be caught.
    const sql = `INSERT INTO "new_x" ("a") SELECT "a"."x" FROM "a" WHERE "a"."y" IN (SELECT "id" FROM "users");`;
    const refs = scanMigrationSql(sql);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ kind: "rebuild", table: "a" });
    expect(refs[0]?.unqualifiedColumns).toEqual(["id"]);
  });

  it("KNOWN LIMITATION (pre-existing, not fixed here): misses a bare column when the select list itself contains a correlated subquery", () => {
    // Pins current behavior, does not assert desired behavior. REBUILD_HEAD's
    // lazy select-list capture binds to the FIRST FROM it finds, which here
    // is the inner correlated subquery's "FROM \"denominations\" \"d\"" —
    // not the outer statement's "FROM \"order_items\"". `findClauseEnd` then
    // walks from that inner match and stops at the inner subquery's own
    // closing paren, so the outer select list's bare "status" and the outer
    // table are never inspected: `table` is misreported as "denominations"
    // and the real hazard (bare "status", which resolves against
    // "order_items") is silently missed. This is a real gap (see
    // `scanMigrationSql`'s doc-comment) but predates the FROM-exemption fix
    // this test file otherwise covers, and fixing it needs a real tokenizer
    // rather than a regex head — out of scope here. If this test ever starts
    // failing because someone fixed the gap, update it to assert the correct
    // (fixed) behavior instead of reverting the fix.
    const sql = `INSERT INTO "new_oi" ("a","b")
      SELECT (SELECT "d"."x" FROM "denominations" "d"), "status" FROM "order_items";`;
    const refs = scanMigrationSql(sql);
    expect(refs).toHaveLength(1);
    // Should be "order_items" with unqualifiedColumns ["status"]; instead:
    expect(refs[0]).toMatchObject({ kind: "rebuild", table: "denominations" });
    expect(refs[0]?.unqualifiedColumns).toEqual([]);
  });
});
