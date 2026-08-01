/*
 * Shared authorization package-boundary coverage.
 *
 * What this proves:
 * 1. Wire contracts and Effect services retain distinct public source roles.
 * 2. The authorization kernel remains independent of authentication,
 *    persistence, HTTP, actor-runtime, and platform implementation packages.
 *
 * This test inspects real package source files. It does not build platform
 * adapters or fake any authorization behavior.
 */
import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("host-authorization import boundary", () => {
  it("keeps contracts, services, and internal derivation in semantic folders", async () => {
    await expect(fileExists(join(packageRoot, "src/contracts"))).resolves.toBe(
      true,
    );
    await expect(fileExists(join(packageRoot, "src/services"))).resolves.toBe(
      true,
    );
    await expect(fileExists(join(packageRoot, "src/internal"))).resolves.toBe(
      true,
    );

    for (const genericFileName of [
      "adapter.ts",
      "errors.ts",
      "policy.ts",
      "schema.ts",
      "services.ts",
      "types.ts",
    ]) {
      await expect(
        fileExists(join(packageRoot, "src", genericFileName)),
      ).resolves.toBe(false);
    }
  });

  it("imports no identity, API, persistence, runtime, or platform package", async () => {
    const sources = await Promise.all(
      (await sourceFiles(join(packageRoot, "src"))).map((path) =>
        readFile(path, "utf8"),
      ),
    );
    const combined = sources.join("\n");

    for (const forbiddenPackage of [
      "@ptools/auth",
      "@ptools/host-api",
      "@ptools/host-cloudflare",
      "@ptools/host-context",
      "@ptools/host-node",
      "@ptools/host-runtime",
      "better-auth",
      "drizzle-orm",
    ]) {
      expect(combined).not.toMatch(packageImport(forbiddenPackage));
    }

    expect(combined).not.toContain("node:");
    expect(combined).not.toContain("@cloudflare");
    expect(combined).not.toContain("alchemy");
    expect(combined).not.toContain("sqlite");
  });
});

const fileExists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const packageImport = (packageName: string): RegExp =>
  new RegExp(`from ["']${packageName}(?:/[^"']*)?["']`);

const sourceFiles = async (
  directory: string,
): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: Array<string> = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
    } else if (entry.isFile() && path.endsWith(".ts")) {
      files.push(path);
    }
  }

  return files;
};
