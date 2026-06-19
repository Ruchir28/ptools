import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const bannedImports = [
  "@ptools/host-node",
  "@ptools/code-mode",
  "@ptools/config",
  "@ptools/executor",
  "@ptools/mcp-registry",
];
const bannedSymbols = [
  "ConfigSource",
  "NodeConfigSourceLive",
  "FileConfigSourceLive",
  "makeCodeModeLive",
  "makeMcpRegistryLive",
  "LocalSandboxExecutorLayer",
];

describe("agent-tools import boundary", () => {
  it("depends only on the Code Mode API for Code Mode calls", async () => {
    const sources = await sourceFiles(join(packageRoot, "src"));

    for (const file of sources) {
      const content = await readFile(file, "utf8");

      for (const banned of bannedImports) {
        expect(content, `${file} must not import ${banned}`).not.toContain(
          `from "${banned}"`,
        );
        expect(content, `${file} must not import ${banned}`).not.toContain(
          `from '${banned}'`,
        );
      }

      for (const banned of bannedSymbols) {
        expect(content, `${file} must not reference ${banned}`).not.toContain(
          banned,
        );
      }
    }
  });
});

const sourceFiles = async (dir: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }

  return files;
};
