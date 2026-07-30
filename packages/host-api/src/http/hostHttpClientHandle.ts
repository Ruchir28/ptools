/**
 * Promise-facing ownership adapter for the Effect-native Host HTTP client.
 *
 * Platform packages supply one `Layer<HostHttpClient>`. This module derives
 * Code Mode from that exact service, owns one ManagedRuntime, and exposes the
 * normal JavaScript handle without duplicating the HTTP protocol.
 */
import {
  type CodeModeClientHandle,
  type CodeModeRequest,
} from "@ptools/code-mode-api";
import { CodeModeClient } from "@ptools/code-mode-api/effect";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import type { HostClientHandle } from "../hostClient.js";
import { makeHostOperationProtocolFailureResponse } from "../hostOperationResponseHelpers.js";
import type {
  HostOperationRequest,
  HostOperationResponse,
} from "../contracts/hostOperationEnvelope.js";
import type { HostHttpClientConfig } from "./hostHttpClientConfig.js";
import {
  CodeModeClientFromHostHttpClientLive,
  HostHttpClient,
  HostHttpClientFetchLive,
} from "../services/hostHttpClient.js";

/** Connect to an already-running deployment of the shared Host HTTP API. */
export const createHostHttpClient = (
  config: HostHttpClientConfig,
): Promise<HostClientHandle> =>
  makeHostHttpClientHandle(HostHttpClientFetchLive(config));

/**
 * Own one Host HTTP layer and derive all Promise-facing capabilities from it.
 * Layer initialization is eager so invalid connection config rejects creation;
 * it performs no network warmup and sends no host lifecycle operation.
 */
export const makeHostHttpClientHandle = async <E>(
  hostLayer: Layer.Layer<HostHttpClient, E, never>,
): Promise<HostClientHandle> => {
  const completeLayer = CodeModeClientFromHostHttpClientLive.pipe(
    Layer.provideMerge(hostLayer),
  );
  const managedRuntime = ManagedRuntime.make(completeLayer);

  try {
    // Eagerly build layers so invalid config fails here, not on first call.
    // No business request is sent; only service construction runs.
    await managedRuntime.context();
    // Tear down the runtime (finalizers + drop services) for handle/codeMode.
    const close = () => managedRuntime.dispose();

    return {
      call: (request) =>
        managedRuntime.runPromise(
          Effect.gen(function* () {
            const host = yield* HostHttpClient;
            return yield* callHostHttpClient(host, request);
          }),
        ),
      codeMode: makeCodeModeClientHandle(managedRuntime, close),
      close,
    };
  } catch (cause) {
    await managedRuntime.dispose();
    throw cause;
  }
};

const makeCodeModeClientHandle = <E>(
  runtime: ManagedRuntime.ManagedRuntime<HostHttpClient | CodeModeClient, E>,
  close: () => Promise<void>,
): CodeModeClientHandle => ({
  call: (request: CodeModeRequest) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* CodeModeClient;
        return yield* client.call(request);
      }),
    ),
  close,
});

/** Interpret the transport-agnostic operation envelope through named routes. */
const callHostHttpClient = (
  host: Context.Service.Shape<typeof HostHttpClient>,
  request: HostOperationRequest,
): Effect.Effect<HostOperationResponse, unknown> => {
  switch (request.operation) {
    case "code_mode":
      return host.codeMode(request.input);
    case "configure":
      return host.configure(request.input);
    case "configure_secrets":
      return host.configureSecrets(request.input);
    case "mcp_auth_status":
      return host.mcpAuthStatus();
    case "start_mcp_auth":
      return host.startMcpAuth(request.input);
    case "complete_mcp_oauth_callback":
      return Effect.succeed(
        makeHostOperationProtocolFailureResponse({
          code: "unknown_operation",
          message:
            "Host HTTP clients do not call browser OAuth callback routes through the operation handle.",
        }),
      );
  }
};
