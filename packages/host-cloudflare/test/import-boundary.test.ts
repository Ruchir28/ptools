import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = join(packageRoot, "..", "..");

describe("host-cloudflare import boundaries", () => {
  it("is not imported by host-neutral packages", async () => {
    const hostNeutralPackages = [
      "agent-tools",
      "auth",
      "code-mode",
      "code-mode-api",
      "config",
      "core",
      "executor",
      "mcp-registry",
      "mcp-server",
    ];
    const contents = await readPackageSources(hostNeutralPackages);

    expect(contents).not.toContain("@ptools/host-cloudflare");
  });

  it("keeps package root exports narrow", async () => {
    const source = await readFile(join(packageRoot, "src/index.ts"), "utf8");

    expect(source).toContain("./errors.js");
    expect(source).not.toContain("./deploy");
    expect(source).not.toContain("./env");
    expect(source).not.toContain("./client");
    expect(source).not.toContain("./layers");
    expect(source).not.toContain("./worker");
  });

  it("keeps the public Worker subpath to runtime entry exports only", async () => {
    const source = await readFile(
      join(packageRoot, "src/worker/index.ts"),
      "utf8",
    );

    expect(source).toContain("default");
    expect(source).toContain("CodeModeObject");
    expect(source).toContain("PtoolsWorkerEnv");
    expect(source).not.toContain("makeCloudflareWorkerHttpApi");
    expect(source).not.toContain("cloudflareWorkerApp");
    expect(source).not.toContain("WorkerIngressLayer");
    expect(source).not.toContain("WorkerIngressCodeModeObjects");
    expect(source).not.toContain("verifyPublicWorkerAuth");
    expect(source).not.toContain("CloudflareWorkerApi");
  });

  it("keeps Worker runtime modules free of deploy, CLI, Node, and container imports", async () => {
    const contents = await readSources(join(packageRoot, "src/worker"));

    expect(contents).not.toContain("../deploy");
    expect(contents).not.toContain("@ptools/cli");
    expect(contents).not.toContain("node:");
    expect(contents).not.toContain("@cloudflare/containers");
  });

  it("does not include first-release stdio container bridge symbols", async () => {
    const contents = await readSources(join(packageRoot, "src"));

    expect(contents).not.toContain("@cloudflare/containers");
    expect(contents).not.toContain("StdioBridgeObject");
    expect(contents).not.toContain("CloudflareStdioBridgeManagerLayer");
    expect(contents).not.toContain("CloudflareStdioMcpConnectorLayer");
  });

  it("keeps Alchemy deployment APIs out of Worker runtime modules", async () => {
    const contents = await readSources(join(packageRoot, "src/worker"));

    expect(contents).not.toContain("alchemy");
    expect(contents).not.toContain("secret.env");
    expect(contents).not.toContain("../deploy");
  });

  it("uses the workspace Effect v3 runtime without an Alchemy runtime dependency", async () => {
    const packageJson = await readFile(join(packageRoot, "package.json"), "utf8");

    expect(packageJson).toContain("\"effect\": \"3.21.2\"");
    expect(packageJson).not.toContain("\"@effect/platform\"");
    expect(packageJson).not.toContain("\"alchemy\"");
    expect(packageJson).not.toContain("4.0.0-beta");
  });

  it("uses Hono as the Worker ingress HTTP adapter", async () => {
    const workerContents = await readSources(join(packageRoot, "src/worker"));
    const packageJson = await readFile(join(packageRoot, "package.json"), "utf8");

    expect(workerContents).toContain("from \"hono\"");
    expect(packageJson).toContain("\"hono\"");
    expect(workerContents).not.toContain("@effect/platform/HttpApi");
    expect(workerContents).not.toContain("@effect/platform/HttpApiBuilder");
    expect(packageJson).not.toContain("\"itty-router\"");
  });

  it("uses request-time Worker bindings from Hono env", async () => {
    const ingress = await readFile(
      join(packageRoot, "src/worker/ingress.ts"),
      "utf8",
    );
    const router = await readFile(
      join(packageRoot, "src/worker/router.ts"),
      "utf8",
    );

    expect(ingress).toContain("PTOOLS_CODE_MODE");
    expect(ingress).toContain("PTOOLS_PUBLIC_ACCESS_TOKEN");
    expect(router).toContain("context.env");
    expect(router).toContain("input.env.PTOOLS_CODE_MODE");
    expect(router).toContain("input.env.PTOOLS_PUBLIC_ACCESS_TOKEN");
    expect(router).not.toContain("WorkerIngressLayer");
    expect(router).not.toContain("yield* WorkerIngress");
    expect(router).not.toContain("Layer.succeed");
  });

  it("keeps Worker ingress routing static and request state local", async () => {
    const entry = await readFile(
      join(packageRoot, "src/worker/entry.ts"),
      "utf8",
    );
    const router = await readFile(
      join(packageRoot, "src/worker/router.ts"),
      "utf8",
    );

    expect(entry).not.toContain("WeakMap");
    expect(entry).not.toContain("handlers.set");
    expect(entry).toContain("cloudflareWorkerApp.fetch(request, env, ctx)");
    expect(router).toContain("Effect.runPromise");
    expect(router).not.toContain("Effect.acquireUseRelease");
    expect(router).not.toContain("dispose()");
    expect(router).not.toContain("new URL(");
    expect(router).not.toContain("RegExp");
    expect(router).not.toContain("try {");
    expect(router).not.toContain("finally");
    expect(router).not.toContain(").handler");
  });

  it("uses Workers-pool bindings instead of fake Durable Object namespaces in tests", async () => {
    const workerTestContents = await Promise.all(
      [
        "test/worker.test.ts",
        "test/worker-entry.ts",
        "test/codeModeObjectTestState.ts",
      ].map((path) => readFile(join(packageRoot, path), "utf8")),
    );
    const testContents = workerTestContents.join("\n");
    const workerConfig = await readFile(
      join(packageRoot, "vitest.worker.config.ts"),
      "utf8",
    );

    expect(workerConfig).toContain("main: \"./test/worker-entry.ts\"");
    expect(workerConfig).toContain("PTOOLS_CODE_MODE: \"TestCodeModeObject\"");
    expect(testContents).toContain("from \"cloudflare:workers\"");
    expect(testContents).not.toContain("as DurableObjectNamespace");
    expect(testContents).not.toContain("CodeModeObjectNamespace");
  });
});

const readPackageSources = async (
  packageNames: ReadonlyArray<string>,
): Promise<string> => {
  const contents = await Promise.all(
    packageNames.map((name) =>
      readSources(join(repoRoot, "packages", name, "src")),
    ),
  );

  return contents.join("\n");
};

const readSources = async (directory: string): Promise<string> => {
  const files = await sourceFiles(directory);
  const contents = await Promise.all(
    files.map((path) => readFile(path, "utf8")),
  );

  return contents.join("\n");
};

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
