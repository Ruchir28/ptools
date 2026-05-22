import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  distFileGlobs,
  publishablePackages,
  requiredFiles,
} from "./publishable-packages.mjs";

const errors = [];
const warnings = [];
const versions = new Map();

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

for (const pkg of publishablePackages) {
  const manifestPath = join(pkg.dir, "package.json");
  const manifest = await readJson(manifestPath);
  const label = manifest.name ?? pkg.name;

  if (manifest.name !== pkg.name) {
    errors.push(`${manifestPath}: expected name ${pkg.name}`);
  }

  versions.set(pkg.name, manifest.version);

  if (manifest.private === true) {
    errors.push(`${label}: publishable packages must not set private: true`);
  }

  if (manifest.type !== "module") {
    errors.push(`${label}: expected type: module`);
  }

  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    errors.push(`${label}: missing version`);
  }

  if (manifest.license !== "MIT") {
    errors.push(`${label}: expected license MIT`);
  }

  if (manifest.repository?.type !== "git" || !manifest.repository?.url) {
    errors.push(`${label}: missing repository metadata`);
  }

  if (manifest.repository?.url?.includes("OWNER/ptools")) {
    warnings.push(
      `${label}: repository URL is still the OWNER/ptools placeholder`,
    );
  }

  if (!manifest.homepage) {
    errors.push(`${label}: missing homepage`);
  }

  if (!manifest.bugs?.url) {
    errors.push(`${label}: missing bugs.url`);
  }

  if (manifest.publishConfig?.access !== "public") {
    errors.push(`${label}: expected publishConfig.access = public`);
  }

  const files = manifest.files;
  if (!Array.isArray(files)) {
    errors.push(`${label}: missing files whitelist`);
  } else {
    for (const entry of [...distFileGlobs, ...requiredFiles]) {
      if (!files.includes(entry)) {
        errors.push(`${label}: files whitelist missing ${entry}`);
      }
    }
  }

  if (manifest.exports === undefined) {
    errors.push(`${label}: missing exports`);
  }

  for (const depName of pkg.internalDeps) {
    if (manifest.dependencies?.[depName] !== "workspace:*") {
      errors.push(
        `${label}: source dependency ${depName} should stay workspace:*`,
      );
    }
  }

  for (const section of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    for (const [depName, depRange] of Object.entries(
      manifest[section] ?? {},
    )) {
      if (depRange === "latest") {
        errors.push(`${label}: ${section}.${depName} must not use latest`);
      }
    }
  }
}

const uniqueVersions = new Set(versions.values());
if (uniqueVersions.size !== 1) {
  errors.push(
    `publishable packages must share one alpha version: ${JSON.stringify(
      Object.fromEntries(versions),
    )}`,
  );
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

if (warnings.length > 0) {
  console.warn(warnings.join("\n"));
}

console.log(
  `publishable package metadata ok (${publishablePackages.length} packages, version ${[...uniqueVersions][0]})`,
);
