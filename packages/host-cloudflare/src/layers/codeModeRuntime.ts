/**
 * @file Config-derived Cloudflare Code Mode runtime layer.
 *
 * This file owns the Durable Object host graph used by CodeModeObject.call(...):
 * stored config/secrets, OAuth-backed credentials, HTTP MCP registry, Dynamic
 * Worker execution, CodeMode, and CodeModeServer. It does not read Worker env
 * directly; stable Durable Object platform values and request origin are
 * provided by CodeModeObject.
 */
import {
  AuthCoordinator,
  AuthError,
  CredentialError,
  McpOAuthStateStore,
} from "@ptools/auth";
import {
  CodeMode,
  CodeModeServerLayer,
  makeCodeModeLive,
  type CodeModeError,
} from "@ptools/code-mode";
import { CodeModeServer } from "@ptools/code-mode-api/effect";
import {
  ResolvedPtoolsConfigSource,
  ConfiguredHostConfigStore,
  ConfiguredSecretStore,
  HostSecretStorage,
  HostStateStorage,
  ServerConfigError,
} from "@ptools/config";
import { ExecutorStartError, type ExecutorError } from "@ptools/executor";
import {
  makeMcpRegistryLive,
  type NameCollisionError,
} from "@ptools/mcp-registry";
import { Data, Effect, Layer, Option } from "effect";
import { CloudflareOAuthFlow, DurableObjectAuthLayer } from "./auth/index.js";
import {
  CloudflareDynamicWorkerExecutorLayer,
  CodeModeObjectWorkerLoader,
} from "./executor/index.js";
import {
  CloudflareHttpMcpConnectorLayer,
  CloudflareMcpConnectorLayer,
} from "./mcpConnector.js";
import {
  CodeModeObjectIdentity,
  CodeModeObjectRequestOrigin,
} from "./platform.js";

export class CloudflareCodeModeRuntimeError extends Data.TaggedError(
  "CloudflareCodeModeRuntimeError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type CloudflareCodeModeRuntimeServices =
  | CodeModeServer
  | CodeMode
  | AuthCoordinator
  | CloudflareOAuthFlow
  | ResolvedPtoolsConfigSource;

const CloudflareCodeModeLayerFromResolvedPtoolsConfigSource: Layer.Layer<
  CodeMode,
  CloudflareCodeModeRuntimeError | ServerConfigError,
  ResolvedPtoolsConfigSource | AuthCoordinator | CodeModeObjectWorkerLoader
> = Layer.unwrapEffect(
  Effect.gen(function* () {
    const source = yield* ResolvedPtoolsConfigSource;
    const config = yield* source.load;

    const registryLayer = makeMcpRegistryLive(config.mcpServers).pipe(
      Layer.provide(CloudflareMcpConnectorLayer),
      Layer.provide(CloudflareHttpMcpConnectorLayer),
    );


    const executorLayer = CloudflareDynamicWorkerExecutorLayer({
      defaultTimeoutMs: Option.match(config.executor, {
        onNone: () => Option.none<number>(),
        onSome: (executor) => executor.defaultTimeoutMs,
      }),
    });

    return makeCodeModeLive().pipe(
      Layer.provide(Layer.merge(registryLayer, executorLayer)),
      Layer.mapError(toRuntimeLayerError),
    );
  }),
);

/**
 * Builds the configured Code Mode host runtime for one Durable Object host and
 * one public request origin.
 *
 * The caller provides stable platform services from CodeModeObjectPlatformLayer
 * plus CodeModeObjectRequestOriginLayer(origin). This layer reads stored config
 * when the ManagedRuntime is built, connects only HTTP MCP transports through
 * the Cloudflare MCP connector, and runs generated JavaScript with Dynamic
 * Workers using the platform-provided Worker Loader.
 */
export const CloudflareCodeModeRuntimeLayer: Layer.Layer<
  CloudflareCodeModeRuntimeServices,
  CloudflareCodeModeRuntimeError | ServerConfigError,
  | HostStateStorage
  | HostSecretStorage
  | McpOAuthStateStore
  | CodeModeObjectIdentity
  | CodeModeObjectWorkerLoader
  | CodeModeObjectRequestOrigin
> = (() => {
  const configSourceLayer = ResolvedPtoolsConfigSource.Default.pipe(
    Layer.provide(ConfiguredSecretStore.Default),
    Layer.provide(ConfiguredHostConfigStore.Default),
  );
  const authLayer = DurableObjectAuthLayer;
  const codeModeLayer = CloudflareCodeModeLayerFromResolvedPtoolsConfigSource.pipe(
    Layer.provide(configSourceLayer),
    Layer.provide(authLayer),
  );
  const serverLayer = CodeModeServerLayer.pipe(
    Layer.provide(codeModeLayer),
  );

  // The same layer values are used both as direct runtime services and as
  // inputs to downstream layers. Effect memoizes layer builds inside one
  // ManagedRuntime MemoMap, so these are not duplicated within the host runtime.
  return Layer.mergeAll(
    serverLayer,
    codeModeLayer,
    authLayer,
    configSourceLayer,
  );
})();

const toRuntimeLayerError = (
  cause:
    | AuthError
    | CredentialError
    | ExecutorStartError
    | ExecutorError
    | NameCollisionError
    | CodeModeError
    | unknown,
): CloudflareCodeModeRuntimeError =>
  new CloudflareCodeModeRuntimeError({
    message:
      cause instanceof ExecutorStartError
        ? `Failed to start Cloudflare Code Mode executor. ${cause.message}`
        : "Failed to start Cloudflare Code Mode runtime.",
    cause,
  });
