/**
 * Guard against browser-side code importing from server-only packages.
 *
 * The two React SPA clients (apps/storefront/client, apps/web-admin/client)
 * must never import from @app/db, @prisma/client, @app/core, or
 * @app/outbox-dispatcher — these are server-only packages that will break
 * the browser bundle if included. This script scans the two client src trees
 * for actual import statements — both `import ... from "..."` and the bare
 * side-effect `import "..."` — rather than prose comments that mention these
 * package names for documentation.
 *
 * Run standalone: `pnpm run check-frontend-boundaries`
 * Also runs automatically as part of `pretest`, next to the other checks.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN_PACKAGES = [
  "@app/db",
  "@prisma/client",
  "@app/core",
  "@app/outbox-dispatcher",
];

// Two alternations, because the two import forms have no keyword in common:
//   1. `from "Y"`      — covers `import X from "Y"`, `import { X } from "Y"`,
//                        `import * as X from "Y"`, and `export ... from "Y"`.
//   2. `import "Y"`    — the bare side-effect import (`import "@app/db/register"`),
//                        which has no `from` at all and so was invisible to
//                        alternation 1 on its own. That form is exactly how a
//                        server-only module with import-time side effects would
//                        sneak into a browser bundle, so it must be caught.
// Whichever alternation matched leaves the package name in its own capture
// group; `checkFile` reads the first one that is set.
const IMPORT_REGEX = /from\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']/g;

interface Violation {
  file: string;
  importPath: string;
}

function walkDir(dir: string, extensions: Set<string>): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkDir(fullPath, extensions));
    } else if (extensions.has(entry.name.split(".").pop()?.toLowerCase() ?? "")) {
      files.push(fullPath);
    }
  }

  return files;
}

function checkFile(filePath: string): Violation[] {
  const content = readFileSync(filePath, "utf-8");
  const violations: Violation[] = [];

  let match;
  while ((match = IMPORT_REGEX.exec(content)) !== null) {
    // Group 1 is the `from "..."` form, group 2 the bare `import "..."` one;
    // exactly one of them is set per match. Explicitly guarded rather than
    // asserted so the loop stays honest under `noUncheckedIndexedAccess`.
    const importPath = match[1] ?? match[2];
    if (importPath === undefined) continue;
    // Check if this import matches any forbidden package or its subpaths
    for (const forbidden of FORBIDDEN_PACKAGES) {
      if (importPath === forbidden || importPath.startsWith(forbidden + "/")) {
        violations.push({ file: filePath, importPath });
        break;
      }
    }
  }

  return violations;
}

function main() {
  const clientDirs = [
    join(process.cwd(), "apps/storefront/client/src"),
    join(process.cwd(), "apps/web-admin/client/src"),
  ];

  const allViolations: Violation[] = [];
  const extensions = new Set(["ts", "tsx"]);

  for (const clientDir of clientDirs) {
    try {
      const files = walkDir(clientDir, extensions);
      for (const file of files) {
        const violations = checkFile(file);
        allViolations.push(...violations);
      }
    } catch (error) {
      console.error(`Failed to scan ${clientDir}: ${error}`);
      process.exit(1);
    }
  }

  if (allViolations.length > 0) {
    console.error(
      "Frontend code must not import from server-only packages. " +
        "The following imports are forbidden:\n",
    );
    for (const violation of allViolations) {
      console.error(`  ${violation.file}: ${violation.importPath}`);
    }
    console.error(
      "\nRemove these imports and mirror/duplicate any needed logic locally.",
    );
    process.exit(1);
  }

  console.log(
    "Frontend boundary check passed: no imports of server-only packages detected.",
  );
  process.exit(0);
}

main();
