# Development Dependency Remediation Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove all remaining audit findings, including development tooling, and push the verified result to origin/master.

**Architecture:** Upgrade Vitest and its coverage provider together to patched 4.1.11; replace removed environmentMatchGlobs with explicit, disjoint Node and jsdom projects that inherit shared settings. Keep Vite on patched major6, upgrade esbuild and the CSS selector parser, and verify the actual installed graph without ignoring advisories.

**Tech Stack:** pnpm9.15.9, Vitest4, Vite6, TypeScript, PostgreSQL16 dummy.

**Spec:** User request to finish the 12 remaining development-tool audit findings; docs/security/dependency-audit-all.json is the baseline.

## Constraints and review focus

- Preserve all580 test files and financial/security assertions; no weakened tests or excluded failures.
- Node>=22.13, no production deployment, provider calls or production migrations.
- Preserve shared aliases, globals, test environment values and20-second timeout in both projects.
- Verify coverage provider compatibility, actual dependency removal, builds and frozen lockfile.

## Tasks

- [x] Capture failing full audit and test-file inventory as baseline.
- [x] Upgrade vitest/coverage to4.1.11, Vite to patched6, esbuild to0.28.2 and postcss-selector-parser7 to7.1.6; migrate environments to projects.
- [x] Install with pinned pnpm9, generate Prisma client, verify audit prod/all and file inventory.
- [x] Run full suite against dummy PostgreSQL, all typechecks, frontend lint/builds, server bundle, guards and coverage compatibility checks; fix demonstrated migration regressions.
- [x] Review changes, document final evidence, clean temporary files, commit and push origin/master.

Ruling: patched esbuild rejects Safari14 destructuring; minimum Safari target explicitly raised to14.1 while retaining allother browser targets. This is documented and communicated; no false syntax-support flags or extra buildpipeline introduced.

Ruling: Vitest4 lifecycle incompatibilities addressed in fixture setup and per-phase mockhistory, with request/payload assertions retained. Full580file suite verified as disjoint node/frontend projects. Final evidence is in docs/security/SECURITY_TEST_REPORT.md.
