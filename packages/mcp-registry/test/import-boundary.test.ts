import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("mcp-registry auth import boundary", () => {
  it("does not import Node auth or transport internals", async () => {
    const sources = await Promise.all(
      (await sourceFiles(join(packageRoot, "src"))).map((path) =>
        readFile(path, "utf8"),
      ),
    );
    const combined = sources.join("\n");

    expect(combined).not.toContain("node:http");
    expect(combined).not.toContain("node:child_process");
    expect(combined).not.toContain("@napi-rs/keyring");
    expect(combined).not.toContain("PtoolsAuthManager");
    expect(combined).not.toContain("@ptools/host-node");
    expect(combined).not.toContain("@modelcontextprotocol/sdk/client/stdio.js");
    expect(combined).not.toContain(
      "@modelcontextprotocol/sdk/client/streamableHttp.js",
    );
    expect(combined).not.toContain("StdioClientTransport");
    expect(combined).not.toContain("StreamableHTTPClientTransport");
  });
});

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
