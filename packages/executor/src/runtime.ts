/**
 * Host-side sandbox runtime boundary.
 *
 * A `SandboxRuntime` knows how to construct and communicate with one kind of
 * sandbox. Deno may spawn a process, Cloudflare may build a Dynamic Worker
 * module graph, and E2B may acquire a remote sandbox. Those mechanics remain
 * private to the layer providing this service.
 *
 * This service runs in the trusted Effect host. It is deliberately separate
 * from the dependency-free `makeSandboxKernel(...)` factory that runs inside
 * the untrusted sandbox.
 */
import { Context, Data, Effect } from "effect";
import type { ExecutorError } from "./errors.js";
import type {
  SandboxCompletion,
  SandboxExecutionPayload,
  SandboxProviderCall,
  SandboxProviderCallResult,
} from "./schema.js";

/** Host callback used by a runtime transport to settle sandbox provider calls. */
export type SandboxProviderCallHandler = (
  call: SandboxProviderCall,
) => Effect.Effect<SandboxProviderCallResult>;

/**
 * Complete input supplied to a platform `SandboxRuntime` for one execution.
 *
 * `payload` is the serializable data sent into the sandbox. The callback stays
 * in the trusted host and is reached only through the runtime's transport.
 */
export class SandboxRuntimeExecution extends Data.Class<{
  readonly payload: SandboxExecutionPayload;
  readonly timeoutMs: number;
  readonly handleProviderCall: SandboxProviderCallHandler;
}> {}

/**
 * Required host capability for constructing and running a sandbox.
 *
 * Providing this service is the composition-time proof that a host selected a
 * concrete sandbox implementation. It does not claim a sandbox is already
 * running: each `execute` call may acquire a fresh process, isolate, container,
 * or remote session and must own that resource's cleanup.
 */
export class SandboxRuntime extends Context.Tag("@ptools/SandboxRuntime")<
  SandboxRuntime,
  {
    readonly execute: (
      execution: SandboxRuntimeExecution,
    ) => Effect.Effect<SandboxCompletion, ExecutorError>;
  }
>() {}
