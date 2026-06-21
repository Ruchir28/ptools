/**
 * @file Cloudflare Dynamic Worker executor constants.
 *
 * These values name the Worker Loader modules, named Workers RPC entrypoint,
 * compatibility date, and first-release resource limits used by
 * `dynamicWorkerDefinition.ts`. They live together so tests and deploy/runtime
 * assembly can verify the exact sandbox package shape without hunting through
 * implementation files.
 */
export const DYNAMIC_WORKER_COMPATIBILITY_DATE = "2026-05-22";
export const DYNAMIC_WORKER_CPU_LIMIT_MS = 1_000;
export const DYNAMIC_WORKER_SUBREQUEST_LIMIT = 100;

export const DYNAMIC_WORKER_MAIN_MODULE = "code-mode-sandbox.js";
export const DYNAMIC_WORKER_GENERATED_CODE_MODULE = "generated-code.js";
export const DYNAMIC_WORKER_ENTRYPOINT_NAME = "CodeModeSandbox";
