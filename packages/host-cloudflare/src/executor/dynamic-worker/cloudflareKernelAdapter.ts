/**
 * @file Cloudflare platform adapter bundled into the fixed Dynamic Worker source.
 *
 * This file runs inside the untrusted Dynamic Worker isolate after
 * host-cloudflare bundles it with `@ptools/executor/sandbox`. It imports the
 * per-execution `generated-code.js` module supplied to Worker Loader, creates
 * the sandbox-side `SandboxHostBridge` over Workers RPC provider handles, and
 * hands the loaded program to the shared sandbox kernel.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { makeSandboxKernel } from "@ptools/executor/sandbox";
import runGenerated, { bindingKeys } from "./generated-code.js";
import type {
  SandboxCompletion,
  SandboxProviderCall,
  SandboxProviderCallResult,
} from "@ptools/executor";

interface DynamicExecutorRunInput {
  readonly payload: {
    readonly globals: Readonly<Record<string, unknown>>;
    readonly providers: ReadonlyArray<{
      readonly name: string;
      readonly tools: ReadonlyArray<string>;
    }>;
  };
}

type ProviderHandle = {
  readonly call: (
    tool: string,
    input: unknown,
    callId: string,
  ) => Promise<SandboxProviderCallResult>;
};

type ProviderHandles = Readonly<Record<string, ProviderHandle | undefined>>;

/**
 * Cloudflare platform adapter that plugs Workers RPC provider handles into the
 * shared sandbox kernel. This class lives inside the untrusted Dynamic Worker;
 * the real provider implementations remain in the trusted Durable Object host.
 */
export class CodeModeSandbox extends WorkerEntrypoint {
  /**
   * Starts one complete sandbox execution inside this loaded Dynamic Worker.
   * Cloudflare calls this as a plain Workers RPC method, so the adapter keeps
   * the sandbox side dependency-free and hands only plain JS values to the
   * shared kernel.
   */
  async runSandboxExecution(
    input: DynamicExecutorRunInput,
    providerHandles: ProviderHandles,
  ): Promise<SandboxCompletion> {
    const sandboxHostBridge = {
      invokeProvider: (call: SandboxProviderCall) => {
        const provider = providerHandles[call.provider];
        if (provider === undefined) {
          return Promise.resolve({
            callId: call.callId,
            ok: false as const,
            error: {
              name: "ProviderNotFound",
              code: "ProviderNotFound",
              message: `Unknown provider: ${call.provider}`,
            },
          });
        }

        return provider.call(call.tool, call.input, call.callId);
      },
    };

    const kernel = makeSandboxKernel(sandboxHostBridge);

    return await kernel.execute({
      program: runGenerated,
      bindingKeys,
      globals: input.payload.globals,
      providers: input.payload.providers,
    });
  }
}
