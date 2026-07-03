import { resolve } from "node:path";
import { AuthCoordinator, AuthError, CredentialError } from "@ptools/auth";
import {
  CodeMode,
  CodeModeServerLayer,
  makeCodeModeLive,
  type CodeModeError,
} from "@ptools/code-mode";
import { CodeModeServer } from "@ptools/code-mode-api/effect";
import {
  ConfigSource,
  ServerConfigError,
} from "@ptools/config";
import { ExecutorStartError, type ExecutorError } from "@ptools/executor";
import {
  makeMcpRegistryLive,
  type NameCollisionError,
} from "@ptools/mcp-registry";
import { Effect, Layer, Option } from "effect";
import {
  NodeAuthCoordinatorLive,
  NodeCredentialsStoreLive,
  NodeMcpAuthFlow,
} from "./auth/index.js";
import {
  FileConfigSourceLive,
  NodeConfigSourceLive,
  ProcessEnvSecretResolverLive,
} from "../config.js";
import {
  HostNodeError,
  type NodeCodeModeHostOptions,
} from "../options.js";
import {
  LocalSandboxExecutorLayer,
} from "../executor/localExecutor.js";
import { NodeMcpConnectorLive } from "../mcpConnector.js";
import {
  NodeConfigDiscoveryContext,
  NodeHostIdentity,
  NodeHostPlatformLive,
  NodeHostRuntimePlatformLive,
  NodeHostSettings,
  type NodeHostProcessPlatform,
} from "./platform/index.js";

/**
 * Services owned by one configured Node host runtime.
 *
 * This is the local analogue of the runtime living behind a Cloudflare Durable
 * Object: it owns Code Mode execution, MCP registry/config loading, auth state,
 * and browser OAuth flow for one selected host id. The HTTP listener should not
 * depend on these services directly; it reaches them through the Node dispatcher
 * / runtime cache boundary.
 */
export type NodeCodeModeRuntimeServices =
  | CodeModeServer
  | AuthCoordinator
  | NodeMcpAuthFlow
  | ConfigSource;

export const NodeCodeModeRuntimeLive = (
  configPath?: string,
  options: NodeCodeModeHostOptions = {},
): Layer.Layer<
  NodeCodeModeRuntimeServices,
  HostNodeError | ServerConfigError,
  never
> =>
  NodeCodeModeRuntimeLiveForHost({
    configPath,
    options,
    hostId: options.hostId,
    processPlatformLayer: NodeHostPlatformLive(options),
  });

export const NodeCodeModeRuntimeLiveForHost = (input: {
  readonly configPath: string | undefined;
  readonly options: NodeCodeModeHostOptions;
  readonly hostId: string | undefined;
  readonly processPlatformLayer: Layer.Layer<NodeHostProcessPlatform>;
}): Layer.Layer<
  NodeCodeModeRuntimeServices,
  HostNodeError | ServerConfigError,
  never
> => {
  const platformLayer = NodeHostRuntimePlatformLive({
    hostId: input.hostId,
    processPlatformLayer: input.processPlatformLayer,
  });
  const configSourceLayer = makeConfigSourceLayer(input.configPath).pipe(
    Layer.provide(platformLayer),
  );
  const authLayer = makeNodeAuthCoordinatorLive().pipe(
    Layer.provide(platformLayer),
  );
  const codeModeLayer = NodeCodeModeLiveFromConfigSource({
    ...(input.options.executor?.denoExecutable === undefined
      ? {}
      : { denoExecutable: input.options.executor.denoExecutable }),
  }).pipe(
    Layer.provide(configSourceLayer),
    Layer.provide(authLayer),
    Layer.provide(platformLayer),
  );
  const serverLayer = CodeModeServerLayer.pipe(Layer.provide(codeModeLayer));

  return Layer.mergeAll(serverLayer, authLayer, configSourceLayer);
};

/** Builds the Node-owned CodeModeServer from shared ptools config discovery. */
export const NodeCodeModeServerLive = (
  configPath?: string,
  options: NodeCodeModeHostOptions = {},
): Layer.Layer<CodeModeServer, HostNodeError | ServerConfigError, never> =>
  NodeCodeModeRuntimeLiveForHost({
    configPath,
    options,
    hostId: options.hostId,
    processPlatformLayer: NodeHostPlatformLive(options),
  });

const NodeCodeModeLiveFromConfigSource = (options: {
  readonly denoExecutable?: string;
} = {}): Layer.Layer<
  CodeMode,
  HostNodeError | ServerConfigError,
  ConfigSource | NodeHostIdentity | NodeHostSettings
> =>
  Layer.unwrapEffect(
    Effect.gen(function* () {
      const source = yield* ConfigSource;
      const config = yield* source.load;

      const registryLayer = makeMcpRegistryLive(config.mcpServers).pipe(
        Layer.provide(NodeMcpConnectorLive),
        Layer.provide(makeNodeAuthCoordinatorLive()),
      );

      const executorLayer = LocalSandboxExecutorLayer({
        ...Option.match(config.executor, {
          onNone: () => ({}),
          onSome: (executor) => ({
            ...Option.match(executor.defaultTimeoutMs, {
              onNone: () => ({}),
              onSome: (defaultTimeoutMs) => ({ defaultTimeoutMs }),
            }),
          }),
        }),
        ...(options.denoExecutable === undefined
          ? {}
          : { denoExecutable: options.denoExecutable }),
      });

      return makeCodeModeLive().pipe(
        Layer.provide(Layer.merge(registryLayer, executorLayer)),
        Layer.mapError((cause) =>
          toHostNodeError(
            cause instanceof ExecutorStartError
              ? `Failed to start local Node Code Mode. ${cause.message}`
              : "Failed to start local Node Code Mode.",
            cause,
          ),
        ),
      );
    }),
  );

const makeNodeAuthCoordinatorLive = (): Layer.Layer<
  AuthCoordinator | NodeMcpAuthFlow,
  HostNodeError,
  NodeHostIdentity | NodeHostSettings
> =>
  Layer.unwrapEffect(
    Effect.gen(function* () {
      const settings = yield* NodeHostSettings;

      return NodeAuthCoordinatorLive().pipe(
        Layer.provide(
          NodeCredentialsStoreLive({ serviceName: settings.auth.serviceName }),
        ),
        Layer.mapError((cause) =>
          toHostNodeError("Failed to start local Node MCP auth.", cause),
        ),
      );
    }),
  );

const makeConfigSourceLayer = (
  configPath: string | undefined,
): Layer.Layer<
  ConfigSource,
  ServerConfigError,
  NodeConfigDiscoveryContext
> =>
  Layer.unwrapEffect(
    Effect.gen(function* () {
      const discovery = yield* NodeConfigDiscoveryContext;

      if (configPath === undefined) {
        return NodeConfigSourceLive({
          argv: discovery.argv,
          env: discovery.env,
          cwd: discovery.cwd,
        });
      }

      return FileConfigSourceLive({
        path: resolve(discovery.cwd, configPath),
      }).pipe(
        Layer.provide(ProcessEnvSecretResolverLive({ env: discovery.env })),
      );
    }),
  );



export const toHostNodeError = (
  message: string,
  cause:
    | AuthError
    | CredentialError
    | ExecutorError
    | NameCollisionError
    | CodeModeError
    | unknown,
): HostNodeError =>
  cause instanceof HostNodeError
    ? cause
    : new HostNodeError({ message, cause });
