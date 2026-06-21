/**
 * @file Trusted-host Workers RPC target for sandbox provider calls.
 *
 * A `ProviderBridge` instance represents one provider namespace for one
 * sandbox execution. It is passed into the Dynamic Worker as a Workers RPC
 * target; when sandbox code calls a provider proxy, Cloudflare invokes this
 * class back in the Durable Object host, where it re-enters the captured Effect
 * runtime and delegates to the shared executor provider-call handler.
 */
import { RpcTarget } from "cloudflare:workers";
import {
  type SandboxProviderCallHandler,
  type SandboxProviderCallResult,
  type SerializedSandboxError,
} from "@ptools/executor";
import { Cause, Exit, Runtime } from "effect";

/**
 * Run-scoped Workers RPC target for one provider namespace.
 * Private fields keep trusted Effect runtime and callbacks outside the
 * RPC-visible surface exposed to the untrusted Dynamic Worker.
 */
export class ProviderBridge extends RpcTarget {
  readonly #providerName: string;
  readonly #handleProviderCall: SandboxProviderCallHandler;
  readonly #runtime: Runtime.Runtime<never>;

  constructor(options: {
    readonly providerName: string;
    readonly handleProviderCall: SandboxProviderCallHandler;
    readonly runtime: Runtime.Runtime<never>;
  }) {
    super();
    this.#providerName = options.providerName;
    this.#handleProviderCall = options.handleProviderCall;
    this.#runtime = options.runtime;
  }

  /**
   * Called by Cloudflare Workers RPC from the Dynamic Worker sandbox proxy.
   *
   * This method must be a normal async method because Cloudflare owns the RPC
   * boundary and does not understand Effect values. The captured runtime lets
   * us re-enter the already-composed Durable Object Effect runtime from this
   * plain JS callback. Use runPromiseExit so typed failures/defects are turned
   * into protocol envelopes instead of rejected RPC promises.
   */
  async call(
    tool: string,
    input: unknown,
    callId: string,
  ): Promise<SandboxProviderCallResult> {
    const exit = await Runtime.runPromiseExit(this.#runtime)(
      this.#handleProviderCall({
        callId,
        provider: this.#providerName,
        tool,
        input,
      }),
    );

    return Exit.match(exit, {
      onSuccess: (result) => result,
      onFailure: (cause) => ({
        callId,
        ok: false as const,
        error: serializeCause(cause, "ProviderBridgeFailure"),
      }),
    });
  }
}

const serializeCause = (
  cause: Cause.Cause<unknown>,
  code: string,
): SerializedSandboxError => ({
  name: "ProviderBridgeFailure",
  code,
  message: Cause.pretty(cause),
});
