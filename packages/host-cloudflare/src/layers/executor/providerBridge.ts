/**
 * @file Trusted-host Workers RPC target for sandbox provider calls.
 *
 * A `ProviderBridge` instance represents one provider namespace for one
 * sandbox execution. It is passed into the Dynamic Worker as a Workers RPC
 * target; when sandbox code calls a provider proxy, Cloudflare invokes this
 * class back in the Durable Object host. The runtime layer binds the
 * run-specific Effect handler into the plain Promise callback stored here.
 */
import { RpcTarget } from "cloudflare:workers";
import type { SandboxProviderCallResult } from "@ptools/executor";

export type ProviderBridgeCall = (
  tool: string,
  input: unknown,
  callId: string,
) => Promise<SandboxProviderCallResult>;

/**
 * Run-scoped Workers RPC target for one provider namespace.
 *
 * The private callback is already bound to the provider name, execution
 * handler, and Effect context by the trusted runtime layer. This class owns
 * only the plain Workers RPC adaptation exposed to the Dynamic Worker.
 */
export class ProviderBridge extends RpcTarget {
  readonly #callProvider: ProviderBridgeCall;

  constructor(options: { readonly callProvider: ProviderBridgeCall }) {
    super();
    this.#callProvider = options.callProvider;
  }

  /** Delegate one Workers RPC invocation to the trusted, run-bound callback. */
  call(
    tool: string,
    input: unknown,
    callId: string,
  ): Promise<SandboxProviderCallResult> {
    return this.#callProvider(tool, input, callId);
  }
}
