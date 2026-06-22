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
    const packageJson = await readFile(
      join(packageRoot, "package.json"),
      "utf8",
    );

    expect(packageJson).toContain('"effect": "3.21.2"');
    expect(packageJson).not.toContain('"@effect/platform"');
    expect(packageJson).not.toContain('"alchemy"');
    expect(packageJson).not.toContain("4.0.0-beta");
  });

  it("uses Hono as the Worker ingress HTTP adapter", async () => {
    const workerContents = await readSources(join(packageRoot, "src/worker"));
    const packageJson = await readFile(
      join(packageRoot, "package.json"),
      "utf8",
    );

    expect(workerContents).toContain('from "hono"');
    expect(packageJson).toContain('"hono"');
    expect(workerContents).not.toContain("@effect/platform/HttpApi");
    expect(workerContents).not.toContain("@effect/platform/HttpApiBuilder");
    expect(packageJson).not.toContain('"itty-router"');
  });

  it("keeps the Worker router as a feature-route composition root", async () => {
    const router = await readFile(
      join(packageRoot, "src/worker/router.ts"),
      "utf8",
    );

    expect(router).toContain('.route("/", healthRoutes)');
    expect(router).toContain('.route("/", codeModeRoutes)');
    expect(router).toContain('.route("/", configRoutes)');
    expect(router).toContain('.route("/", mcpAuthRoutes)');
    expect(router).not.toContain("context.env");
    expect(router).not.toContain("Effect.");
    expect(router).not.toContain("PTOOLS_CODE_MODE");
  });

  it("uses request-time Worker bindings from Hono env", async () => {
    const ingress = await readFile(
      join(packageRoot, "src/worker/ingress.ts"),
      "utf8",
    );
    const workerContents = await readSources(join(packageRoot, "src/worker"));

    expect(ingress).toContain("PTOOLS_CODE_MODE");
    expect(ingress).toContain("PTOOLS_PUBLIC_ACCESS_TOKEN");
    expect(workerContents).toContain("context.env");
    expect(workerContents).toContain("input.env.PTOOLS_CODE_MODE");
    expect(workerContents).toContain("input.env.PTOOLS_PUBLIC_ACCESS_TOKEN");
    expect(workerContents).not.toContain("WorkerIngressLayer");
    expect(workerContents).not.toContain("yield* WorkerIngress");
    expect(workerContents).not.toContain("Layer.succeed");
  });

  it("keeps Worker ingress routing static and request state local", async () => {
    const entry = await readFile(
      join(packageRoot, "src/worker/entry.ts"),
      "utf8",
    );
    const workerContents = await readSources(join(packageRoot, "src/worker"));

    expect(entry).not.toContain("WeakMap");
    expect(entry).not.toContain("handlers.set");
    expect(entry).toContain("cloudflareWorkerApp.fetch(request, env, ctx)");
    expect(workerContents).toContain("Effect.runPromise");
    expect(workerContents).toContain("new URL(request.url).origin");
    expect(workerContents).not.toContain("Effect.acquireUseRelease");
    expect(workerContents).not.toContain("dispose()");
    expect(workerContents).not.toContain("RegExp");
    expect(workerContents).not.toContain("try {");
    expect(workerContents).not.toContain("finally");
    expect(workerContents).not.toContain(").handler");
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
    const [workerConfig, wranglerConfig] = await Promise.all([
      readFile(join(packageRoot, "vitest.worker.config.ts"), "utf8"),
      readFile(join(packageRoot, "wrangler.test.jsonc"), "utf8"),
    ]);

    expect(workerConfig).toContain('configPath: "./wrangler.test.jsonc"');
    expect(wranglerConfig).toContain('"main": "./test/worker-entry.ts"');
    expect(wranglerConfig).toContain('"name": "PTOOLS_CODE_MODE"');
    expect(wranglerConfig).toContain('"class_name": "TestCodeModeObject"');
    expect(wranglerConfig).toContain('"binding": "PTOOLS_EXECUTION_LOADER"');
    expect(testContents).toContain('from "cloudflare:workers"');
    expect(testContents).not.toContain("as DurableObjectNamespace");
    expect(testContents).not.toContain("CodeModeObjectNamespace");
  });

  it("keeps Durable Object OAuth flow separate from the shared AuthCoordinator service", async () => {
    const authEntry = await readFile(
      join(packageRoot, "src/layers/auth.ts"),
      "utf8",
    );
    const auth = [
      authEntry,
      await readSources(join(packageRoot, "src/layers/auth")),
    ].join("\n");
    const codeModeObject = await readFile(
      join(packageRoot, "src/objects/CodeModeObject.ts"),
      "utf8",
    );
    const config = await readFile(
      join(packageRoot, "src/layers/config.ts"),
      "utf8",
    );

    expect(auth).toContain("CloudflareOAuthFlow");
    expect(auth).toContain("DurableObjectAuthLayer");
    expect(auth).toContain("yield* CodeModeObjectStorage");
    expect(auth).toContain("yield* CodeModeObjectIdentity");
    expect(auth).toContain("AuthCoordinatorCore");
    expect(auth).toContain("AuthCoordinatorCoreLayer");
    expect(auth).toContain("AuthProviderFactory");
    expect(auth).toContain("AuthCoordinatorPolicy");
    expect(auth).toContain("CloudflareOAuthPlatform");
    expect(auth).toContain("Requires:");
    expect(auth).toContain("Provides:");
    expect(authEntry).toContain('export * from "./auth/index.js"');
    expect(auth).not.toContain("DurableObjectAuthLayer = (options");
    expect(auth).not.toContain("DurableObjectCredentialsStoreLayer = (options");
    expect(auth).not.toContain("readonly records: Ref.Ref");
    expect(auth).not.toContain("readonly providers: Ref.Ref");
    expect(auth).not.toContain("readonly oauthServers: Ref.Ref");
    expect(auth).not.toContain("authorizedHandler: Ref.Ref");
    expect(auth).not.toContain("refreshHandler: Ref.Ref");
    expect(auth).not.toContain("CloudflareAuthStateService");
    expect(auth).not.toContain("CloudflareAuthStateLayer");
    expect(auth).not.toContain("CloudflareAuthStateSnapshot");
    expect(config).toContain("yield* CodeModeObjectStorage");
    expect(config).toContain("yield* CodeModeObjectIdentity");
    expect(config).not.toContain("DurableObjectConfigSourceLayer = (options");
    expect(config).not.toContain("DurableObjectSecretResolverLayer = (options");
    expect(auth).not.toContain("CloudflareAuthManager");
    expect(auth).not.toContain("CloudflareAuthCoordinatorHooks");
    expect(auth).not.toContain("AuthCoordinatorService &");
    expect(codeModeObject).toContain("CodeModeObjectPlatformLayer");
    expect(codeModeObject).toContain("#hostRuntime");
    expect(codeModeObject).toContain("ManagedRuntime.make");
    expect(codeModeObject).toContain("initializeConfiguredMcpAuth");
    expect(codeModeObject).not.toContain("withAuthCoordinator");
    expect(codeModeObject).not.toContain(
      "AuthCoordinatorServiceWithCloudflareHooks",
    );
    expect(codeModeObject).not.toContain("beginAuthorization?:");
    expect(codeModeObject).not.toContain("finishAuthorization?:");
    expect(codeModeObject).not.toContain("DurableObjectAuthCoordinatorLayer");
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
