import {
  HostInstanceHandler,
  HostStableRuntimeLayer,
  type HostStableRuntimeServices,
} from "@ptools/host-runtime";
import { DurableObject } from "cloudflare:workers";
import { Effect, Layer, ManagedRuntime } from "effect";
import {
  CloudflareDynamicWorkerSandboxRuntimeLayer,
  makeCodeModeObjectWorkerLoader,
} from "../layers/executor/index.js";
import {
  CloudflareHttpMcpConnectorLayer,
  CloudflareMcpConnectorLayer,
} from "../layers/mcpConnector.js";
import {
  CodeModeObjectPlatformLayer,
  requireDurableObjectHostId,
} from "../layers/platform.js";
import type { PtoolsWorkerEnv } from "../worker/ingress.js";
import {
  decodeCloudflareHostOperationRpcInput,
  type CloudflareHostOperationRpcInput,
  type CloudflareHostOperationRpcResponse,
} from "./codeModeObject/rpc.js";

export type {
  CloudflareHostOperationRpcInput,
  CloudflareHostOperationRpcResponse,
  CodeModeObjectRpc,
} from "./codeModeObject/rpc.js";

type StableHostRuntime = ManagedRuntime.ManagedRuntime<
  HostStableRuntimeServices,
  unknown
>;

export class CodeModeObject extends DurableObject<PtoolsWorkerEnv> {
  readonly #hostId: string;
  readonly #stableRuntime: StableHostRuntime;

  constructor(ctx: DurableObjectState, env: PtoolsWorkerEnv) {
    super(ctx, env);

    this.#hostId = requireDurableObjectHostId(ctx);
    const cloudflarePlatformLayer = CodeModeObjectPlatformLayer({
      state: ctx,
      workerLoader: makeCodeModeObjectWorkerLoader(env.PTOOLS_EXECUTION_LOADER),
    });
    const cloudflarePrimitiveLayer = Layer.mergeAll(
      CloudflareMcpConnectorLayer.pipe(
        Layer.provide(CloudflareHttpMcpConnectorLayer),
      ),
      CloudflareDynamicWorkerSandboxRuntimeLayer,
    ).pipe(Layer.provideMerge(cloudflarePlatformLayer));

    this.#stableRuntime = ManagedRuntime.make(
      HostStableRuntimeLayer({ supportsStdioMcp: false }).pipe(
        Layer.provide(cloudflarePrimitiveLayer),
      ),
    );
  }

  /** Handle one normalized operation through the shared host-instance handler. */
  handleHostOperation(
    input: CloudflareHostOperationRpcInput,
  ): Promise<CloudflareHostOperationRpcResponse> {
    return this.#stableRuntime.runPromise(
      Effect.gen(function* () {
        const handler = yield* HostInstanceHandler;
        const operation = yield* decodeCloudflareHostOperationRpcInput(input);
        return yield* handler.handle(operation);
      }),
    );
  }
}
