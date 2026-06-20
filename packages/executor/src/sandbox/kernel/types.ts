import type {
  SandboxCompletion,
  SandboxProviderCall,
  SandboxProviderCallResult,
} from "../protocol.js";

/**
 * Represents a compiled, callable user program inside the sandbox.
 *
 * This type is erased at build time. It is a plain JavaScript function that
 * accepts a single `bindings` object containing all injected variables (globals,
 * provider proxies, and the captured console).
 *
 * Lexical scoping allows the user's code within the program to seamlessly access
 * these destructured local variables without global namespace pollution.
 */
export type SandboxProgram = (
  bindings: Readonly<Record<string, unknown>>,
) => unknown | Promise<unknown>;

/**
 * Represents the platform-specific bridge for carrying provider calls from the
 * untrusted sandbox to the trusted host.
 *
 * Every platform supplies a plain JavaScript function implementing this contract:
 * - **Deno**: Implements it using standard I/O (`stdin`/`stdout`) and a pending-Promise map.
 * - **Cloudflare Workers**: Implements it by invoking a Workers RPC stub method.
 *
 * It is intentionally a simple function type, not an Effect service, layer, or class,
 * because it executes inside the generated-code sandbox where Effect is not loaded.
 */
export type SandboxProviderInvoker = (
  call: SandboxProviderCall,
) => Promise<SandboxProviderCallResult>;

/**
 * Platform bridge required when constructing the Shared Sandbox Kernel.
 *
 * The bridge is created by the sandbox entrypoint, not by generated code. Its
 * presence makes host communication an initialization requirement rather than
 * an optional argument that can be forgotten on an individual execution.
 */
export interface SandboxHostBridge {
  readonly invokeProvider: SandboxProviderInvoker;
}

/** Input for one execution after the platform has loaded the program. */
export interface SandboxKernelExecution {
  /** The compiled or loaded user program function to execute. */
  readonly program: SandboxProgram;

  /**
   * Exact lexical binding keys the platform loader compiled into the program.
   * The kernel validates these against its binding plan before execution so a
   * loader/kernel drift cannot degrade into undefined variables inside user code.
   */
  readonly bindingKeys: ReadonlyArray<string>;

  /** Top-level global variables to inject into the program's execution scope. */
  readonly globals: Readonly<Record<string, unknown>>;

  /** Manifests listing the available providers and their tools to expose as proxies. */
  readonly providers: ReadonlyArray<{
    readonly name: string;
    readonly tools: ReadonlyArray<string>;
  }>;
}

/**
 * The promise resolving to a standardized sandbox execution completion envelope.
 */
export type SandboxProgramResult = Promise<SandboxCompletion>;

/** Initialized sandbox execution engine with its required host bridge captured. */
export interface SandboxKernel {
  readonly execute: (execution: SandboxKernelExecution) => SandboxProgramResult;
}
