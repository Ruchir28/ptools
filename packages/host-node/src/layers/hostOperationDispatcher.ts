import { AuthCoordinator, AuthError } from "@ptools/auth";
import { CodeModeServer } from "@ptools/code-mode-api/effect";
import {
  makeHostOperationProtocolFailureResponse,
  type CompleteHostMcpOAuthCallbackResponse,
  type HostMcpAuthStatusResponse,
  type HostOperationRequest,
  type HostOperationResponse,
  type StartHostMcpAuthResponse,
} from "@ptools/host-api";
import {
  HostOperationDispatchError,
  HostOperationDispatcher,
} from "@ptools/host-api/effect";
import { Context, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { NodeMcpAuthFlow } from "./auth/index.js";
import {
  NodeCodeModeRuntimeLiveForHost,
  type NodeCodeModeRuntimeServices,
} from "./codeModeRuntime.js";
import {
  type HostNodeError,
  type NodeCodeModeHostOptions,
} from "../options.js";
import { ConfigSource, type ServerConfigError } from "@ptools/config";
import {
  NodeHostPlatformLive,
  type NodeHostProcessPlatform,
} from "./platform/index.js";

type NodeDispatcherServices = {
  readonly codeModeServer: Context.Tag.Service<typeof CodeModeServer>;
  readonly authCoordinator: Context.Tag.Service<typeof AuthCoordinator>;
  readonly mcpAuthFlow: Context.Tag.Service<typeof NodeMcpAuthFlow>;
};

/**
 * Temporary Node host-instance boundary behind the shared Host API dispatcher.
 *
 * The HTTP server does not build or depend on `CodeModeServer`. It mounts the
 * shared `HostHttpApi`, which passes the route `hostId` here. This dispatcher
 * then creates/caches one managed Code Mode/auth runtime for that requested host
 * id and runs the decoded operation against it.
 *
 * In the next host-runtime refactor, this cache becomes the Node-local
 * `ConfiguredHostRuntimeManager`, and this dispatcher should delegate through a
 * `HostInstanceDirectory` / `HostInstanceHandle` boundary instead of owning the
 * map directly.
 */
export const NodeHostOperationDispatcherLive = (
  configPath?: string,
  options: NodeCodeModeHostOptions = {},
): Layer.Layer<
  HostOperationDispatcher,
  never,
  never
> =>
  NodeHostOperationDispatcherLiveWithPlatform({
    configPath,
    options,
    processPlatformLayer: NodeHostPlatformLive(options),
  });

export const NodeHostOperationDispatcherLiveWithPlatform = (input: {
  readonly configPath: string | undefined;
  readonly options: NodeCodeModeHostOptions;
  readonly processPlatformLayer: Layer.Layer<NodeHostProcessPlatform>;
}): Layer.Layer<HostOperationDispatcher, never, never> =>
  Layer.scoped(
    HostOperationDispatcher,
    Effect.gen(function* () {
      const runtimes = new Map<
        string,
        ManagedRuntime.ManagedRuntime<
          NodeCodeModeRuntimeServices,
          HostNodeError | ServerConfigError
        >
      >();

      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          Promise.all([...runtimes.values()].map((runtime) => runtime.dispose())),
        ).pipe(Effect.ignore),
      );

      return HostOperationDispatcher.of({
        dispatch: (dispatchInput) => {
          const runtime = getOrCreateRuntimeForHost({
            runtimes,
            hostId: dispatchInput.hostId,
            configPath: input.configPath,
            options: input.options,
            processPlatformLayer: input.processPlatformLayer,
          });

          return Effect.tryPromise({
            try: () =>
              runtime.runPromiseExit(runNodeHostOperation(dispatchInput.request)),
            catch: (cause) =>
              new HostOperationDispatchError({
                message: `Node host operation dispatch failed for ${dispatchInput.hostId}.`,
                cause,
              }),
          }).pipe(
            Effect.flatMap(
              Exit.matchEffect({
                onSuccess: Effect.succeed,
                onFailure: (cause) => {
                  const hostNodeError = findHostNodeError(cause);

                  if (
                    dispatchInput.request.operation === "code_mode" &&
                    hostNodeError !== undefined
                  ) {
                    return Effect.succeed({
                      operation: "code_mode" as const,
                      result: {
                        ok: false as const,
                        error: {
                          code: "code_mode_server_failure" as const,
                          message: hostNodeError.message,
                        },
                      },
                    });
                  }

                  return Effect.fail(
                    new HostOperationDispatchError({
                      message: `Node host operation dispatch failed for ${dispatchInput.hostId}.`,
                      cause,
                    }),
                  );
                },
              }),
            ),
          );
        },
      });
    }),
  );


const runNodeHostOperation = (
  request: HostOperationRequest,
): Effect.Effect<
  HostOperationResponse,
  HostNodeError | ServerConfigError,
  NodeCodeModeRuntimeServices
> =>
  Effect.gen(function* () {
    const codeModeServer = yield* CodeModeServer;
    const authCoordinator = yield* AuthCoordinator;
    const mcpAuthFlow = yield* NodeMcpAuthFlow;
    const configSource = yield* ConfigSource;
    const config = yield* configSource.load;

    for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
      yield* authCoordinator.noteConfigured(serverName, serverName, serverConfig);
    }

    return yield* handleNodeHostRequest(
      { codeModeServer, authCoordinator, mcpAuthFlow },
      request,
    );
  });

const findHostNodeError = (
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): HostNodeError | undefined => {
  if (value instanceof Error && "_tag" in value && value._tag === "HostNodeError") {
    return value as HostNodeError;
  }

  if (typeof value !== "object" || value === null || seen.has(value)) {
    return undefined;
  }

  seen.add(value);

  for (const key of [
    ...Object.keys(value),
    ...Object.getOwnPropertySymbols(value),
  ]) {
    const nested = findHostNodeError(
      (value as Record<PropertyKey, unknown>)[key],
      seen,
    );

    if (nested !== undefined) {
      return nested;
    }
  }

  return undefined;
};

const getOrCreateRuntimeForHost = (input: {
  readonly runtimes: Map<
    string,
    ManagedRuntime.ManagedRuntime<
      NodeCodeModeRuntimeServices,
      HostNodeError | ServerConfigError
    >
  >;
  readonly hostId: string;
  readonly configPath: string | undefined;
  readonly options: NodeCodeModeHostOptions;
  readonly processPlatformLayer: Layer.Layer<NodeHostProcessPlatform>;
}): ManagedRuntime.ManagedRuntime<
  NodeCodeModeRuntimeServices,
  HostNodeError | ServerConfigError
> => {
  const existing = input.runtimes.get(input.hostId);
  if (existing !== undefined) {
    return existing;
  }

  const runtime = ManagedRuntime.make(
    NodeCodeModeRuntimeLiveForHost({
      configPath: input.configPath,
      options: input.options,
      hostId: input.hostId,
      processPlatformLayer: input.processPlatformLayer,
    }),
  );
  input.runtimes.set(input.hostId, runtime);
  return runtime;
};

/**
 * Interprets one decoded `HostOperationRequest` against Node's local runtime.
 *
 * Operation failures are encoded as `HostOperationResponse` values instead of
 * failing the dispatcher effect. Only carrier/platform failures belong on the
 * `HostOperationDispatcher` error channel, and this Node implementation has no
 * asynchronous carrier once the request has reached the in-memory dispatcher.
 */
const handleNodeHostRequest = (
  services: NodeDispatcherServices,
  request: HostOperationRequest,
): Effect.Effect<HostOperationResponse, never> => {
  switch (request.operation) {
    case "code_mode":
      return services.codeModeServer.handle(request.input).pipe(
        Effect.map((response) => ({
          operation: "code_mode" as const,
          result: { ok: true as const, response },
        })),
        Effect.catchAll((cause) =>
          Effect.succeed({
            operation: "code_mode" as const,
            result: {
              ok: false as const,
              error: {
                code:
                  cause._tag === "CodeModeInvalidRequestError"
                    ? ("invalid_code_mode_request" as const)
                    : ("code_mode_server_failure" as const),
                message: cause.message,
              },
            },
          }),
        ),
      );

    case "mcp_auth_status":
      return services.authCoordinator.status.pipe(
        Effect.map(
          (status): HostMcpAuthStatusResponse => ({
            operation: "mcp_auth_status",
            result: { ok: true, status },
          }),
        ),
      );

    case "start_mcp_auth":
      return services.mcpAuthFlow
        .beginAuthorization({
          serverName: request.input.serverName,
          force: request.input.force === true,
        })
        .pipe(
          Effect.map(
            ({ authorizeUrl }): StartHostMcpAuthResponse => ({
              operation: "start_mcp_auth",
              result: { ok: true, authorizeUrl },
            }),
          ),
          Effect.catchAll((cause) =>
            Effect.succeed({
              operation: "start_mcp_auth" as const,
              result: {
                ok: false as const,
                error: authErrorToHostMcpAuthError(cause),
              },
            }),
          ),
        );

    case "complete_mcp_oauth_callback":
      return services.mcpAuthFlow
        .completeCallback(request.input)
        .pipe(
          Effect.map(
            (response): CompleteHostMcpOAuthCallbackResponse => ({
              operation: "complete_mcp_oauth_callback",
              result: { ok: true, response },
            }),
          ),
          Effect.catchAll((cause) =>
            Effect.succeed({
              operation: "complete_mcp_oauth_callback" as const,
              result: {
                ok: false as const,
                error: authErrorToHostMcpAuthError(cause),
              },
            }),
          ),
        );

    case "configure":
    case "configure_secrets":
      return Effect.succeed(
        makeHostOperationProtocolFailureResponse({
          code: "unknown_operation",
          message:
            "Node file-backed hosts do not support remote configure/configure_secrets operations.",
        }),
      );
  }
};

const authErrorToHostMcpAuthError = (cause: AuthError) => ({
  code: "auth_unavailable" as const,
  message: cause.message,
});
