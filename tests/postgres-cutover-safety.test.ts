import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { transformSync } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const tempRoots: string[] = [];

function bashExecutable(): string {
  if (process.platform !== "win32") return "bash";
  const gitBash = "C:/Program Files/Git/bin/bash.exe";
  return existsSync(gitBash) ? gitBash : "bash";
}

function cutoverFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "postgres-cutover-safety-"));
  tempRoots.push(root);
  mkdirSync(join(root, "deploy"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(join(REPO_ROOT, "deploy", "postgres-cutover.sh"), join(root, "deploy", "postgres-cutover.sh"));
  chmodSync(join(root, "deploy", "postgres-cutover.sh"), 0o755);
  writeFileSync(join(root, "docker-compose.postgres.prod.yml"), "services: {}\n");
  writeFileSync(join(root, "scripts", "migrate-sqlite-to-postgres.ts"), "// fixture\n");
  writeFileSync(join(root, "scripts", "reconcile-sqlite-postgres.ts"), "// fixture\n");
  writeFileSync(join(root, ".env"), "DATABASE_URL_PRISMA=postgresql://fixture\n");
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Postgres production cutover safety", () => {
  it("disables entrypoint auto-migration for every schema/import/reconciliation one-off", () => {
    const root = cutoverFixture();
    const result = spawnSync(
      bashExecutable(),
      [
        "-lc",
        String.raw`
          docker() {
            if [ "$1" = compose ] && [ "$2" = version ]; then
              printf '%s\n' 'Docker Compose version v2.24.0'
            fi
            return 0
          }
          export -f docker
          ./deploy/postgres-cutover.sh --dry-run
        `,
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "run --rm -e AUTO_MIGRATE=0 server pnpm exec prisma db push --schema prisma/schema.prisma",
    );
    expect(result.stdout).toContain(
      "run --rm -e AUTO_MIGRATE=0 server pnpm exec tsx scripts/migrate-sqlite-to-postgres.ts",
    );
    expect(result.stdout).toContain(
      "run --rm -e AUTO_MIGRATE=0 server pnpm exec tsx scripts/reconcile-sqlite-postgres.ts",
    );
    expect(result.stdout).not.toContain("run --rm server");

    const finalStart = result.stdout.split("\n").find((line) => line.includes("up -d --build"));
    expect(finalStart).toBeDefined();
    expect(finalStart).not.toContain("AUTO_MIGRATE=0");
  });

  it("keeps the reconciliation gate parseable as TypeScript", () => {
    const source = readFileSync(join(REPO_ROOT, "scripts", "reconcile-sqlite-postgres.ts"), "utf8");

    expect(() => transformSync(source, { loader: "ts", target: "node22" })).not.toThrow();
  });
});
