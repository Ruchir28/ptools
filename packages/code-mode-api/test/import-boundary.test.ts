import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("code-mode-api import boundary", () => {
  it("keeps public surfaces in semantic folders instead of generic root files", async () => {
    await expect(fileExists(join(packageRoot, "src/contracts"))).resolves.toBe(
      true,
    );
    await expect(fileExists(join(packageRoot, "src/services"))).resolves.toBe(
      true,
    );
    await expect(fileExists(join(packageRoot, "src/validation"))).resolves.toBe(
      true,
    );

    for (const genericFileName of [
      "errors.ts",
      "schema.ts",
      "effect.ts",
      "services.ts",
      "types.ts",
      "validation.ts",
    ]) {
      await expect(
        fileExists(join(packageRoot, "src", genericFileName)),
      ).resolves.toBe(false);
    }
  });

  it("does not import Code Mode, host, adapter, or platform internals", async () => {
    const sources = await Promise.all(
      (await sourceFiles(join(packageRoot, "src"))).map((path) =>
        readFile(path, "utf8"),
      ),
    );
    const combined = sources.join("\n");

    expect(combined).not.toMatch(packageImport("@ptools/code-mode"));
    expect(combined).not.toMatch(packageImport("@ptools/host-node"));
    expect(combined).not.toMatch(packageImport("@ptools/mcp-server"));
    expect(combined).not.toMatch(packageImport("@ptools/agent-tools"));
    expect(combined).not.toMatch(packageImport("@ptools/executor"));
    expect(combined).not.toMatch(packageImport("@ptools/mcp-registry"));
    expect(combined).not.toContain('from "@ptools/auth"');
    expect(combined).not.toContain("from '@ptools/auth'");
    expect(combined).not.toContain("@modelcontextprotocol");
    expect(combined).not.toContain("node:");
    expect(combined).not.toContain("@cloudflare");
  });
});

const fileExists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const packageImport = (packageName: string): RegExp =>
  new RegExp(`from [\"']${packageName}(?:/[^\"']*)?[\"']`);

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
