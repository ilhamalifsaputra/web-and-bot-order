/**
 * The one fixed Postgres schema name the whole Playwright suite shares —
 * used by both playwright.config.ts (to compute the schema-scoped
 * DATABASE_URL_PRISMA it hands to the storefront's webServer process) and
 * seed.ts / global-teardown.ts (which create/seed/drop that exact schema).
 * Namespaced with this worktree's branch topic, not a generic "e2e", so a
 * concurrent Playwright run from a different worktree — sharing the SAME
 * dev Postgres container per this repo's CLAUDE.md — can never collide with
 * this one's schema.
 */
export const E2E_SCHEMA = "e2e_frontend_arch_doc_reconcile";

/** Same technique as tests/helpers/testdb.ts's withSchema: preserves any
 * query params already on the base URL instead of string-concatenating. */
export function withSchema(baseUrl: string, schema: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set("schema", schema);
  return url.toString();
}
