/**
 * @file check-packed-artifacts.mjs
 * 
 * Pre-publish safety validation script for the monorepo.
 * 
 * Purpose:
 * Simulates the exact npm/pnpm publishing process by running `pnpm pack` inside a
 * temporary directory for each publishable package. This acts as a dry-run safety net
 * to ensure we never publish broken, incomplete, or bloated packages to npm.
 * 
 * Key Validations:
 * 1. Integrity: Verifies that critical files (README.md, LICENSE, package.json) are present.
 * 2. Completeness: Ensures that the compiled `dist/` build outputs exist.
 * 3. Export/Import Resolution: Recursively extracts and verifies that all local target files
 *    referenced in the package's "exports" and "imports" fields (e.g., nested worker paths like
 *    `dist/executor/sandbox-worker.js`) are actually bundled inside the packed tarball.
 * 4. Dependency Safety: Confirms that no local "workspace:*" dependency references remain,
 *    and that internal dependency versions match the published package version.
 * 5. Cleanliness: Enforces a strict file allowlist (via `isAllowedFile`) to prevent leaking
 *    private source code, test suites, or build cache metadata (like `.tsbuildinfo`).
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { publishablePackages } from "./publishable-packages.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const packDir = await mkdtemp(join(tmpdir(), "ptools-pack-"));
const errors = [];

const readSourceManifest = async (pkg) =>
  JSON.parse(await readFile(join(root, pkg.dir, "package.json"), "utf8"));

const pack = (pkg) => {
  const before = new Set(
    execFileSync("find", [packDir, "-type", "f"])
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean),
  );

  execFileSync(
    "pnpm",
    ["--dir", join(root, pkg.dir), "pack", "--pack-destination", packDir],
    { stdio: "pipe" },
  );

  const after = execFileSync("find", [packDir, "-type", "f"])
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);

  const created = after.filter((path) => !before.has(path));
  if (created.length !== 1) {
    throw new Error(
      `${pkg.name}: expected one tarball, found ${created.length} in ${packDir}`,
    );
  }

  return created[0];
};

const listTar = (tarball) =>
  execFileSync("tar", ["-tf", tarball]).toString().trim().split("\n");

const readPackedManifest = (tarball) =>
  JSON.parse(
    execFileSync("tar", ["-xOf", tarball, "package/package.json"]).toString(),
  );

const localPackageTargets = (value) => {
  if (typeof value === "string") {
    return value.startsWith("./") ? [value] : [];
  }
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(localPackageTargets);
};

const isAllowedFile = (file) => {
  if (
    file === "package/package.json" ||
    file === "package/README.md" ||
    file === "package/LICENSE"
  ) {
    return true;
  }

  if (!file.startsWith("package/dist/")) {
    return false;
  }

  if (file.endsWith(".tsbuildinfo")) {
    return false;
  }

  return (
    file.endsWith(".js") ||
    file.endsWith(".js.map") ||
    file.endsWith(".d.ts") ||
    file.endsWith(".d.ts.map")
  );
};

try {
  for (const pkg of publishablePackages) {
    const sourceManifest = await readSourceManifest(pkg);
    const tarball = pack(pkg);
    const files = listTar(tarball);
    const packedManifest = readPackedManifest(tarball);

    for (const required of [
      "package/package.json",
      "package/README.md",
      "package/LICENSE",
    ]) {
      if (!files.includes(required)) {
        errors.push(`${pkg.name}: packed artifact missing ${required}`);
      }
    }

    if (!files.some((file) => file.startsWith("package/dist/"))) {
      errors.push(`${pkg.name}: packed artifact missing dist output`);
    }

    for (const target of localPackageTargets({
      exports: sourceManifest.exports,
      imports: sourceManifest.imports,
    })) {
      const expected = `package/${String(target).replace(/^\.\//, "")}`;
      if (!files.includes(expected)) {
        errors.push(
          `${pkg.name}: packed artifact missing export target ${expected}`,
        );
      }
    }

    for (const file of files) {
      if (!isAllowedFile(file)) {
        errors.push(`${pkg.name}: unexpected packed file ${file}`);
      }
    }

    const dependencySections = [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ];

    for (const section of dependencySections) {
      for (const [depName, depRange] of Object.entries(
        packedManifest[section] ?? {},
      )) {
        if (String(depRange).startsWith("workspace:")) {
          errors.push(
            `${pkg.name}: packed ${section}.${depName} still uses ${depRange}`,
          );
        }
      }
    }

    for (const depName of pkg.internalDeps) {
      const packedRange = packedManifest.dependencies?.[depName];
      if (packedRange !== sourceManifest.version) {
        errors.push(
          `${pkg.name}: packed dependency ${depName} expected ${sourceManifest.version}, got ${packedRange}`,
        );
      }
    }
  }

  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`packed artifacts ok (${publishablePackages.length} packages)`);
  }
} finally {
  await rm(packDir, { recursive: true, force: true });
}
