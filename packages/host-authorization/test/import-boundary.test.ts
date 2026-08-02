/*
 * Shared authorization package-boundary coverage.
 *
 * What this proves:
 * 1. Domain values, operation contracts, and Effect services retain distinct
 *    and discoverable source roles.
 * 2. Every HostAccessStore operation is packaged from its semantic module and
 *    returns domain successes without optional smart-constructor conventions.
 * 3. The authorization kernel remains independent of authentication,
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
    await expect(
      fileExists(join(packageRoot, "src/contracts/hostAccessOperations")),
    ).resolves.toBe(true);

    const operationFiles = [
      "createMembership.ts",
      "createOwnedHost.ts",
      "listHostRoles.ts",
      "listUserHosts.ts",
      "replaceMembershipRoles.ts",
      "getHostRole.ts",
      "getRegisteredHost.ts",
      "resolveUserHostAccess.ts",
    ] as const;

    for (const operationFile of operationFiles) {
      await expect(
        fileExists(
          join(
            packageRoot,
            "src/contracts/hostAccessOperations",
            operationFile,
          ),
        ),
      ).resolves.toBe(true);
    }

    const operationSources = await Promise.all(
      operationFiles.map((operationFile) =>
        readFile(
          join(
            packageRoot,
            "src/contracts/hostAccessOperations",
            operationFile,
          ),
          "utf8",
        ),
      ),
    );
    expect(operationSources.join("\n")).not.toMatch(/make[A-Z]\w+Result/);

    for (const obsoleteBroadFile of [
      "hostMemberAccessOperations.ts",
      "hostRoleOperations.ts",
      "registeredHostOperations.ts",
    ]) {
      await expect(
        fileExists(join(packageRoot, "src/contracts", obsoleteBroadFile)),
      ).resolves.toBe(false);
    }
    await expect(
      fileExists(
        join(packageRoot, "src/services/hostAccessResultConstructors.ts"),
      ),
    ).resolves.toBe(false);

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

  it("publishes nested operation modules with the contracts artifact", async () => {
    const manifest = JSON.parse(
      await readFile(join(packageRoot, "package.json"), "utf8"),
    ) as { readonly files?: ReadonlyArray<string> };

    expect(manifest.files).toEqual(
      expect.arrayContaining(["dist/**/*.js", "dist/**/*.d.ts"]),
    );
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
