import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { buildDynamicWorkerDefinition } from "../src/layers/executor/dynamicWorkerDefinition.js";
import {
  DYNAMIC_WORKER_COMPATIBILITY_DATE,
  DYNAMIC_WORKER_CPU_LIMIT_MS,
  DYNAMIC_WORKER_GENERATED_CODE_MODULE,
  DYNAMIC_WORKER_MAIN_MODULE,
  DYNAMIC_WORKER_SUBREQUEST_LIMIT,
} from "../src/layers/executor/constants.js";
import { renderGeneratedCodeModule } from "../src/executor/dynamic-worker/generatedCodeModuleRenderer.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("Cloudflare Dynamic Worker executor source packaging", () => {
  it("builds the Worker Loader code package with fixed adapter and generated code modules", async () => {
    const workerCode = await Effect.runPromise(
      buildDynamicWorkerDefinition({
        code: "async () => sheets.read({ id })",
        globals: { id: "123" },
        providers: [{ name: "sheets", tools: ["read"] }],
      }),
    );

    expect(workerCode.compatibilityDate).toBe(
      DYNAMIC_WORKER_COMPATIBILITY_DATE,
    );
    expect(workerCode.mainModule).toBe(DYNAMIC_WORKER_MAIN_MODULE);
    expect(workerCode.globalOutbound).toBeNull();
    expect(workerCode.limits).toEqual({
      cpuMs: DYNAMIC_WORKER_CPU_LIMIT_MS,
      subRequests: DYNAMIC_WORKER_SUBREQUEST_LIMIT,
    });
    expect(Object.keys(workerCode.modules).sort()).toEqual([
      DYNAMIC_WORKER_MAIN_MODULE,
      DYNAMIC_WORKER_GENERATED_CODE_MODULE,
    ].sort());
    expect(workerCode.modules[DYNAMIC_WORKER_MAIN_MODULE]).toEqual({
      js: expect.stringContaining("CodeModeSandbox"),
    });
    expect(workerCode.modules[DYNAMIC_WORKER_GENERATED_CODE_MODULE]).toEqual({
      js: expect.stringContaining("export default async function runGenerated"),
    });
  });

  it("renders generated-code.js without provider implementations or host callbacks", async () => {
    const source = await Effect.runPromise(
      renderGeneratedCodeModule({
        code: "async () => sheets.read({ id })",
        globals: { id: "123" },
        providers: [{ name: "sheets", tools: ["read"] }],
      }),
    );

    expect(source).toContain('export const bindingKeys = ["id","sheets","console"]');
    expect(source).toContain("const { id, sheets, console } = __bindings;");
    expect(source).toContain("const generatedFunction = (async () => sheets.read({ id }));");
    expect(source).not.toContain("ProviderBridge");
    expect(source).not.toContain("Mcp");
    expect(source).not.toContain("credentials");
  });

  it("keeps the Cloudflare adapter bundle platform-specific and dependency-clean", async () => {
    const adapter = await readFile(
      join(
        packageRoot,
        "src/executor/dynamic-worker/cloudflareKernelAdapter.ts",
      ),
      "utf8",
    );
    const sourceConstant = await readFile(
      join(
        packageRoot,
        "src/executor/dynamic-worker/cloudflareKernelAdapterSource.ts",
      ),
      "utf8",
    );

    expect(adapter).toContain('from "cloudflare:workers"');
    expect(adapter).toContain('from "@ptools/executor/sandbox"');
    expect(adapter).toContain("class CodeModeSandbox extends WorkerEntrypoint");
    expect(adapter).toContain("runSandboxExecution");
    expect(sourceConstant).toContain("DYNAMIC_SANDBOX_WORKER_SOURCE");
    expect(sourceConstant).toContain("CodeModeSandbox");
    expect(sourceConstant).not.toContain('from "effect"');
    expect(sourceConstant).not.toContain("node:");
    expect(sourceConstant).not.toContain("@cloudflare/containers");
    expect(sourceConstant).not.toContain("alchemy");
  });
});
