/**
 * @file Builds the Worker Loader source package for one sandbox execution.
 *
 * The trusted host calls this from `dynamicWorkerRuntimeLayer.ts` before
 * `WorkerLoader.load(...)`. It combines the fixed, package-built Cloudflare
 * platform-kernel adapter source with a freshly rendered `generated-code.js`
 * module for the current execution, then applies the first-release resource
 * limits and disabled outbound network policy.
 */
import {
  ExecutorProtocolError,
  type SandboxExecutionPayload,
} from "@ptools/executor";
import { Effect } from "effect";
import { renderGeneratedCodeModule } from "../../executor/dynamic-worker/generatedCodeModuleRenderer.js";
import { DYNAMIC_SANDBOX_WORKER_SOURCE } from "../../executor/dynamic-worker/cloudflareKernelAdapterSource.js";
import {
  DYNAMIC_WORKER_COMPATIBILITY_DATE,
  DYNAMIC_WORKER_CPU_LIMIT_MS,
  DYNAMIC_WORKER_GENERATED_CODE_MODULE,
  DYNAMIC_WORKER_MAIN_MODULE,
  DYNAMIC_WORKER_SUBREQUEST_LIMIT,
} from "./constants.js";

/**
 * Builds the exact Worker Loader source package for one sandbox execution.
 * The fixed Cloudflare adapter/kernel source is package-built; generated code
 * is rendered from this execution's already-validated payload.
 */
export const buildDynamicWorkerDefinition = (
  payload: SandboxExecutionPayload,
): Effect.Effect<WorkerLoaderWorkerCode, ExecutorProtocolError> =>
  Effect.gen(function* () {
    const generatedCode = yield* renderGeneratedCodeModule(payload);

    return {
      compatibilityDate: DYNAMIC_WORKER_COMPATIBILITY_DATE,
      mainModule: DYNAMIC_WORKER_MAIN_MODULE,
      modules: {
        [DYNAMIC_WORKER_MAIN_MODULE]: {
          js: DYNAMIC_SANDBOX_WORKER_SOURCE,
        },
        [DYNAMIC_WORKER_GENERATED_CODE_MODULE]: {
          js: generatedCode,
        },
      },
      globalOutbound: null,
      limits: {
        cpuMs: DYNAMIC_WORKER_CPU_LIMIT_MS,
        subRequests: DYNAMIC_WORKER_SUBREQUEST_LIMIT,
      },
    };
  });
