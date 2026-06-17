/**
 * Temporary Node/local execution backend, reachable only via the
 * `@ptools/executor/internal/local` subpath (NOT the host-neutral root export).
 * It adapts the child-process sandbox to the `ExecutorBackend` SPI so it can
 * compose with `CodeExecutorLayer`. A later sub-ticket will move this into
 * `@ptools/host-node` as `LocalSandboxExecutorBackendLayer`.
 */
export * from "./LocalSandboxExecutor.js";
export type { LocalSandboxExecutorOptions } from "./types.js";
