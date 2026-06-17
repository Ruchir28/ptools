/**
 * Host-implemented execution SPI (Service Provider Interface).
 *
 * `ExecutorBackend` is the lower-level capability consumed by
 * `CodeExecutorLayer`. Where `CodeExecutor` says "run this generated code
 * request and return an `ExecuteResult`", `ExecutorBackend` says "given a
 * fully prepared request, run it with this host's platform mechanics and
 * return the raw sandbox completion envelope".
 *
 * This split exists so request normalization, provider-call semantics, and
 * result decoding stay shared and host-neutral (see `semantic.ts`), while only
 * the physical execution differs per host:
 *
 *   - `@ptools/host-node` today: a child-process sandbox over local HTTP RPC
 *     (see `./internal/local`).
 *   - `@ptools/host-cloudflare` later: a Dynamic Worker / RpcTarget bridge.
 *
 * Composition contract:
 *
 *   CodeExecutorLayer.pipe(Layer.provide(myBackendLayer))
 *
 * A backend receives only `PreparedExecuteRequest`s. It must NOT reimplement
 * `CodeExecutor` semantics, must NOT depend on `McpRegistry`, and must NOT
 * re-decode results — provider callbacks are already closed over the registry
 * by Code Mode, and result decoding is shared via `decodeSandboxCompleteResult`.
 * `CodeMode` itself never depends on `ExecutorBackend`; it only sees
 * `CodeExecutor`.
 */
import { Context, Effect } from "effect";
import type { ExecutorError } from "./errors.js";
import type { SandboxCompleteRequest } from "./schema.js";
import type { PreparedExecuteRequest } from "./types.js";

export class ExecutorBackend extends Context.Tag("@ptools/ExecutorBackend")<
  ExecutorBackend,
  {
    /**
     * Run a prepared request on this host and return the raw sandbox
     * completion envelope. The envelope is interpreted by the shared
     * `decodeSandboxCompleteResult` in `semantic.ts`.
     */
    readonly executePrepared: (
      request: PreparedExecuteRequest,
    ) => Effect.Effect<SandboxCompleteRequest, ExecutorError>;
  }
>() {}
