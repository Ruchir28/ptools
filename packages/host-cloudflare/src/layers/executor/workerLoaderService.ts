/**
 * @file Effect service wrapper around Cloudflare's Worker Loader binding.
 *
 * `CodeModeObjectPlatformLayer` supplies the real `PTOOLS_EXECUTION_LOADER`
 * binding through this service. The wrapper hides raw Worker Loader details
 * from the sandbox runtime layer and exposes only `loadSandbox(...)`, which
 * loads one source package and returns the named `CodeModeSandbox` RPC client.
 */
import { Context, Effect } from "effect";
import { ExecutorStartError } from "@ptools/executor";
import type {
  CodeModeSandboxEntrypoint,
  DynamicWorkerSandboxClient,
} from "./types.js";
import { DYNAMIC_WORKER_ENTRYPOINT_NAME } from "./constants.js";

export interface CodeModeObjectWorkerLoaderService {
  /**
   * Load one Dynamic Worker source package and return the narrow RPC client
   * used by the sandbox runtime. This deliberately uses WorkerLoader.load(...)
   * so each execution receives its own generated-code module package.
   */
  readonly loadSandbox: (
    code: WorkerLoaderWorkerCode,
  ) => Effect.Effect<DynamicWorkerSandboxClient, ExecutorStartError>;
}

/** Worker Loader binding owned by the CodeModeObject Durable Object env. */
export class CodeModeObjectWorkerLoader extends Context.Tag(
  "@ptools/host-cloudflare/CodeModeObjectWorkerLoader",
)<CodeModeObjectWorkerLoader, CodeModeObjectWorkerLoaderService>() {}

/**
 * Converts the raw Cloudflare WorkerLoader binding into the narrow service
 * value provided by `CodeModeObjectPlatformLayer`.
 *
 * This is the edge adapter from Durable Object env values into the Effect
 * service graph. Below this point, executor layers depend on
 * `CodeModeObjectWorkerLoader` instead of receiving or exposing the raw
 * `PTOOLS_EXECUTION_LOADER` binding.
 */
export const makeCodeModeObjectWorkerLoader = (
  loader: WorkerLoader,
): CodeModeObjectWorkerLoaderService => ({
  loadSandbox: (code) =>
    Effect.try({
      try: () => {
        const worker = loader.load(code);
        const entrypoint = worker.getEntrypoint<CodeModeSandboxEntrypoint>(
          DYNAMIC_WORKER_ENTRYPOINT_NAME,
        );

        return {
          runSandboxExecution: (input, providerHandles) =>
            entrypoint.runSandboxExecution(input, providerHandles),
        };
      },
      catch: (cause) =>
        new ExecutorStartError({
          message: "Failed to load Cloudflare Dynamic Worker sandbox",
          cause,
        }),
    }),
});
