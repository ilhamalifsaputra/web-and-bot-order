/**
 * Pure logic behind scripts/check-migration-rebuild-quoting.ts, extracted so
 * it is importable/unit-testable (the CLI script itself calls `process.exit`
 * at module scope and previously exported nothing, which is why the H-9
 * guard shipped with zero tests despite guarding a real data-corruption bug
 * — see that file's header for the full story).
 *
 * Exports:
 *   - `sanitizeSql`             — comment-stripper (also masks string-literal
 *                                 contents so they can never be mistaken for
 *                                 real SQL by the regexes below).
 *   - `findUnqualifiedSources`  — flags bare (non-table-qualified) quoted
 *                                 identifiers in a fragment of SQL.
 *   - `scanMigrationSql`        — walks a whole migration file's SQL and
 *                                 returns every rebuild-copy / subquery
 *                                 `SELECT ... FROM` reference, each with its
 *                                 list of unqualified source columns.
 */

/**
 * Advances past a quoted span — `'...'` or `"..."` — starting at `sql[start]`,
 * honouring SQL's doubled-quote escape (`''` inside a string literal, `""`
 * inside a quoted identifier). Returns the index just past the closing quote,
 * or `sql.length` if the quote is never closed (malformed/truncated SQL).
 *
 * Shared by `sanitizeSql` (walking raw SQL) and `findClauseEnd` (walking
 * already-sanitized SQL) — both need the same "don't get confused by
 * punctuation inside a quoted span" behaviour.
 */
function skipQuotedSpan(sql: string, start: number): number {
  const quote = sql[start];
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        // Doubled quote is an escaped literal quote character, not the end
        // of the span — e.g. 'it''s' is one string literal.
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return sql.length;
}

/**
 * Single left-to-right pass that strips `-- line` and `/* block *\/` SQL
 * comments and masks the contents of `'...'` string literals, tracking at
 * every character whether it is inside a string literal, a quoted
 * identifier, or neither. This replaces a prior two-regex implementation
 * that had zero string-literal awareness and so failed in both directions:
 *
 *   - A `--` inside a string literal (`SET note = 'has -- dashes'`) deleted
 *     the rest of that physical line — including the closing quote — a
 *     false negative that also corrupted later match boundaries by leaving
 *     the quote unbalanced.
 *   - A double-quoted word inside a string literal (`'say "hi"'`) was
 *     indistinguishable from a real quoted identifier, a false positive.
 *
 * Comments are only recognised outside string/identifier literals (so `--`
 * or `/*` inside a quoted identifier is left alone too, though that's a much
 * rarer shape in practice). Double quotes *inside* a string literal are
 * masked to `x` so `QUOTED_IDENTIFIER` below can never match across a string
 * literal boundary; the literal's own delimiting `'` characters and every
 * other character are preserved so `findClauseEnd` can still walk past the
 * literal without miscounting parentheses or semicolons that happen to
 * appear inside it.
 */
export function sanitizeSql(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const c2 = sql[i + 1];
    if (c === "-" && c2 === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i = Math.min(i + 2, sql.length);
      continue;
    }
    if (c === "'") {
      const end = skipQuotedSpan(sql, i);
      out += sql.slice(i, end).replace(/"/g, "x");
      i = end;
      continue;
    }
    if (c === '"') {
      const end = skipQuotedSpan(sql, i);
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Starting right after a `FROM`/`INTO` table reference, finds the end of the
 * enclosing statement or subquery on *already-sanitized* SQL (so comments are
 * gone and string literals can't hide stray parens/semicolons): the next
 * top-level `;`, or the `)` that closes an enclosing subquery — whichever
 * comes first — tracking paren depth and skipping over quoted spans. Falls
 * back to end-of-string for the final, unterminated statement in a file.
 *
 * This is what lets the scan see past the first `FROM "table"` into the
 * `WHERE`/`JOIN ... ON` clauses that follow — the actual real-world hazard
 * lives in a correlated backfill's `WHERE`, not just the select list.
 */
function findClauseEnd(sql: string, from: number): number {
  let depth = 0;
  let i = from;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      i = skipQuotedSpan(sql, i);
      continue;
    }
    if (c === "(") {
      depth++;
      i++;
      continue;
    }
    if (c === ")") {
      if (depth === 0) return i; // closes something OUTSIDE this clause
      depth--;
      i++;
      continue;
    }
    if (c === ";" && depth === 0) return i;
    i++;
  }
  return sql.length;
}

/** Every double-quoted identifier, so each can be classified in context. */
const QUOTED_IDENTIFIER = /"([^"]+)"/g;

/**
 * SQL keywords that can legally precede a bare quoted identifier without
 * that identifier being an *alias* of whatever came before it. Needed once
 * `findUnqualifiedSources` is also run over `WHERE`/`JOIN ... ON` text (see
 * `findClauseEnd`): without this list, `WHERE "status" = ...` or
 * `AND "col" = ...` would be misread as `"status"`/`"col"` being an implicit
 * alias of the keyword in front of them, silently exempting exactly the bare
 * references this guard exists to catch.
 */
const KEYWORDS = new Set([
  "AND", "OR", "NOT", "WHERE", "ON", "JOIN", "INNER", "OUTER", "LEFT",
  "RIGHT", "FULL", "CROSS", "SELECT", "FROM", "SET", "VALUES", "WHEN",
  "THEN", "ELSE", "CASE", "END", "IN", "IS", "LIKE", "BETWEEN", "EXISTS",
  "ORDER", "GROUP", "BY", "HAVING", "UNION", "ALL", "DISTINCT", "AS",
  "NULL", "DEFAULT", "INSERT", "INTO", "UPDATE", "DELETE", "CREATE",
  "TABLE", "PRIMARY", "KEY", "REFERENCES", "CONSTRAINT", "CHECK", "UNIQUE",
  "INDEX", "LIMIT", "OFFSET", "ASC", "DESC", "COLLATE", "CAST",
]);

/**
 * True when `before` — the text immediately preceding a candidate bare
 * identifier — ends in the tail of another expression (a closing quote, a
 * closing paren, or a non-keyword bare word) with nothing but whitespace in
 * between, i.e. the *implicit* alias form `<expr> "alias"` (no `AS`). A
 * comma, operator, or SQL keyword immediately before never introduces an
 * alias, so `"a", "b"` and `WHERE "col"` are correctly left un-exempted.
 */
function isImplicitAlias(before: string): boolean {
  const wordMatch = /(\w+)\s*$/.exec(before);
  const word = wordMatch?.[1];
  if (word) return !KEYWORDS.has(word.toUpperCase());
  return /["\)]\s*$/.test(before);
}

/**
 * Returns the source columns in `sqlFragment` that are written bare rather
 * than table-qualified. Skips the qualifier and column halves of
 * `"t"."c"` pairs, column aliases (`... AS "name"` and the implicit
 * `... "name"` form), and table names immediately after `JOIN` (a join
 * target is a table reference, not a column read).
 */
export function findUnqualifiedSources(sqlFragment: string): string[] {
  const bare: string[] = [];
  for (const match of sqlFragment.matchAll(QUOTED_IDENTIFIER)) {
    const start = match.index;
    const end = start + match[0].length;
    // `"table"."column"` — the qualifier is followed by a dot, the column
    // preceded by one. Either half means this reference is qualified.
    if (sqlFragment[end] === "." || sqlFragment[start - 1] === ".") continue;
    const before = sqlFragment.slice(0, start);
    // `... AS "alias"` names an output column; it never resolves against the
    // source table, so the string-literal fallback cannot apply to it.
    if (/\bAS\s*$/i.test(before)) continue;
    // `JOIN "table"` names a join target, not a column read.
    if (/\bJOIN\s*$/i.test(before)) continue;
    // `FROM "table"` names a source table, not a column read — the tail scan
    // (`findClauseEnd`) routinely contains a second, nested FROM (a
    // correlated `IN (SELECT ... FROM "t")` subquery, or a UNION's second
    // arm), and that table name must not be misread as a bare column.
    if (/\bFROM\s*$/i.test(before)) continue;
    if (isImplicitAlias(before)) continue;
    const identifier = match[1];
    if (identifier !== undefined) bare.push(identifier);
  }
  return bare;
}

/**
 * Matches one rebuild copy: `INSERT INTO "new_x" (<targets>) SELECT
 * <sources> FROM <table>`. `<table>` accepts both the quoted and bare forms
 * — an unquoted `FROM orders` used to match neither regex in this file at
 * all, leaving the whole statement (select list included) uninspected.
 */
const REBUILD_HEAD =
  /INSERT\s+INTO\s+"(new_\w+)"\s*\([^)]*\)\s*SELECT\s+([\s\S]*?)\s+FROM\s+(?:"(\w+)"|(\w+))/gi;

/**
 * Matches any OTHER `SELECT <sources> FROM <table>` in the file — most
 * realistically a correlated subquery inside an `UPDATE ... SET col =
 * (SELECT ... FROM "table" WHERE ...)` backfill, but this also catches a
 * bare standalone SELECT. Same table-name flexibility as `REBUILD_HEAD`.
 * Matches that fall inside an already-counted `REBUILD_HEAD` span are
 * skipped by the caller so the same statement is never reported twice.
 */
const SUBQUERY_HEAD = /SELECT\s+([\s\S]*?)\s+FROM\s+(?:"(\w+)"|(\w+))/gi;

export interface SourceReference {
  kind: "rebuild" | "subquery";
  /** The table the SELECT reads FROM. */
  table: string;
  /**
   * Source columns read bare (no table qualifier) anywhere in this
   * reference's select list *and* the clauses that follow it (`WHERE`,
   * `JOIN ... ON`, etc., up to the end of the enclosing statement or
   * subquery). Empty when every column is properly qualified.
   */
  unqualifiedColumns: string[];
}

/**
 * Scans one migration file's raw SQL (comments included — this strips them
 * itself) and returns every rebuild-copy and subquery `SELECT ... FROM`
 * reference it finds, each annotated with its unqualified source columns.
 *
 * For each match, the inspected region runs from the select list all the way
 * to the end of the enclosing statement or subquery (via `findClauseEnd`),
 * not just up to the first `FROM` — so a bare column read in a `WHERE` or
 * `JOIN ... ON` clause is caught, not just ones in the select list.
 *
 * KNOWN GAP (pre-existing, not fixed by the FROM-exemption follow-up,
 * 2026-08-02): `REBUILD_HEAD`/`SUBQUERY_HEAD`'s `[\s\S]*?` select-list capture
 * is lazy, so when a select list *itself* contains a correlated subquery
 * (`SELECT (SELECT ... FROM "inner") , "col" FROM "outer"`), the head regex
 * binds to the innermost/earliest `FROM` — the inner subquery's — not the
 * outer statement's. `findClauseEnd` then walks from that inner table
 * reference and stops at the inner subquery's own closing paren, so the
 * outer statement's remaining select-list items and its `WHERE`/`JOIN`
 * clauses are never inspected (and `table` is misreported as the inner
 * table). See `sqlQuoting.test.ts`'s pinned-limitation test for a concrete
 * missed case. Not fixed here — the regex-head approach would need
 * a real tokenizer to track select-list nesting correctly; out of scope for
 * this guard's current design.
 */
export function scanMigrationSql(rawSql: string): SourceReference[] {
  const sql = sanitizeSql(rawSql);
  const references: SourceReference[] = [];
  const rebuildSpans: Array<[number, number]> = [];

  for (const head of sql.matchAll(REBUILD_HEAD)) {
    const start = head.index;
    const selectList = head[2];
    const table = head[3] ?? head[4] ?? "";
    const tableEnd = start + head[0].length;
    const clauseEnd = findClauseEnd(sql, tableEnd);
    rebuildSpans.push([start, clauseEnd]);
    const tail = sql.slice(tableEnd, clauseEnd);
    references.push({
      kind: "rebuild",
      table,
      unqualifiedColumns: findUnqualifiedSources(`${selectList} ${tail}`),
    });
  }

  for (const head of sql.matchAll(SUBQUERY_HEAD)) {
    const start = head.index;
    const tableEnd = start + head[0].length;
    // Already accounted for as (part of) a REBUILD_HEAD match — the same
    // "SELECT ... FROM ..." text nests inside that larger "INSERT INTO
    // "new_x" (...) SELECT ... FROM <table>" span. Skip it so it isn't
    // reported twice under two different categories.
    if (rebuildSpans.some(([s, e]) => start >= s && start < e)) continue;
    const selectList = head[1];
    const table = head[2] ?? head[3] ?? "";
    const clauseEnd = findClauseEnd(sql, tableEnd);
    const tail = sql.slice(tableEnd, clauseEnd);
    references.push({
      kind: "subquery",
      table,
      unqualifiedColumns: findUnqualifiedSources(`${selectList} ${tail}`),
    });
  }

  return references;
}
