/**
 * Guard against browser-side code importing from server-only packages.
 *
 * The two React SPA clients (apps/storefront/client, apps/web-admin/client)
 * must never import from @app/db, @prisma/client, @app/core, or
 * @app/outbox-dispatcher — these are server-only packages that will break
 * the browser bundle if included. This script scans the two client src trees
 * for actual `import ... from "..."` statements (not prose comments that
 * mention these package names for documentation).
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

// Regex to match import statements: `from "..."` or `from '...'`
// This matches: `import X from "Y"`, `import "Y"`, `import { X } from "Y"`, etc.
// The capture group extracts the quoted package name.
const IMPORT_FROM_REGEX = /from\s+["']([^"']+)["']/g;

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
  while ((match = IMPORT_FROM_REGEX.exec(content)) !== null) {
    const importPath = match[1];
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
