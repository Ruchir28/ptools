/**
 * @file Typed seam between the trusted Durable Object runtime and Dynamic Worker.
 *
 * These interfaces describe the narrow Workers RPC surface returned by
 * `workerLoaderService.ts` and consumed by `dynamicWorkerRuntimeLayer.ts`.
 * They intentionally model only the sandbox execution method and provider RPC
 * handles, not the full Worker Loader or Durable Object APIs.
 */
import type { SandboxCompletion, SandboxExecutionPayload } from "@ptools/executor";
import type { Rpc } from "@cloudflare/workers-types";
import type { ProviderBridge } from "./providerBridge.js";

/**
 * Serializable execution data passed to the Dynamic Worker RPC method.
 * Live provider callbacks are passed separately as Workers RPC stubs.
 */
export interface DynamicExecutorRunInput {
  readonly payload: SandboxExecutionPayload;
  readonly bindingKeys: ReadonlyArray<string>;
}

/**
 * Named Workers RPC class exported by the fixed Cloudflare kernel-adapter
 * bundle. The trusted host calls this method after WorkerLoader.load(...)
 * installs the fixed adapter and per-execution generated-code module.
 */
export interface CodeModeSandboxEntrypoint
  extends Rpc.WorkerEntrypointBranded {
  readonly runSandboxExecution: (
    input: DynamicExecutorRunInput,
    providerHandles: DynamicExecutorProviderHandles,
  ) => Promise<SandboxCompletion>;
}

/** Provider namespace -> run-scoped trusted-host RPC target. */
export type DynamicExecutorProviderHandles = Readonly<
  Record<string, ProviderBridge>
>;

/** Narrow client returned by the Worker Loader service to the sandbox runtime. */
export interface DynamicWorkerSandboxClient {
  readonly runSandboxExecution: CodeModeSandboxEntrypoint["runSandboxExecution"];
}
