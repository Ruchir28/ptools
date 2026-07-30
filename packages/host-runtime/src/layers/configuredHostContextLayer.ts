/**
 * @file Config/origin-derived service graph for configured host operations.
 *
 * Pair with `HostStableRuntimeLayer`: that layer lives for the host instance;
 * this layer is rebuilt when config/secrets change or the public origin binding
 * misses the runner cache.
 *
 * On each build it loads the current persisted config/secrets, creates
 * origin-aware auth policy and providers, connects the MCP registry, adapts the
 * platform sandbox into a CodeExecutor, and exposes Code Mode plus its
 * transport-neutral server adapter.
 *
 * `ConfiguredHostContextRunner` owns construction and caching. Platform
 * RPC/HTTP methods do not build this layer — they enter through the runner,
 * which supplies stable stores/identity, the current `HostPublicOrigin`, and
 * platform ports (`McpConnector`, `SandboxRuntime`).
 */
import {
  AuthCoordinator,
  AuthCoordinatorCore,
  AuthError,
  CredentialError,
  McpOAuthCredentialStore,
  McpOAuthFlow,
  McpOAuthProviderFactoryLayer,
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
  ConfiguredHostConfigStore,
  ConfiguredSecretStore,
  ResolvedPtoolsConfigSource,
  ServerConfigError,
} from "@ptools/config";
import {
  CodeExecutorLayer,
  ExecutorBackendLayer,
  ExecutorStartError,
  SandboxRuntime,
  type ExecutorError,
} from "@ptools/executor";
import { HostIdentity, HostPublicOrigin } from "@ptools/host-context";
import {
  makeMcpRegistryLive,
  McpConnector,
  type NameCollisionError,
} from "@ptools/mcp-registry";
import { Effect, Layer, Option } from "effect";
import { ConfiguredHostContextError } from "../errors.js";
import { HostAuthCoordinatorPolicyLayer } from "./hostAuthCoordinatorPolicyLayer.js";

/**
 * Services available to Effects passed to `ConfiguredHostContextRunner.run`.
 *
 * This is the contents of one cached configured Context — what callers may
 * `yield*` after entering through the runner. It is not a `ManagedRuntime`, and
 * it does not include platform ports or stable stores: those are consumed while
 * building the Context, then left outside the cached surface.
 */
export type ConfiguredHostOperationServices =
  | CodeModeServer
  | CodeMode
  | AuthCoordinator
  | McpOAuthFlow
  | ResolvedPtoolsConfigSource;

/**
 * Load the resolved config once for this context build, then create its MCP
 * registry and executor graph. Rebuilding the configured Context is therefore
 * what makes changed config, secrets, and executor defaults take effect.
 */
const ConfiguredCodeModeLayerFromResolvedConfig: Layer.Layer<
  CodeMode,
  ConfiguredHostContextError | ServerConfigError,
  ResolvedPtoolsConfigSource | AuthCoordinator | McpConnector | SandboxRuntime
> = Layer.unwrap(
  Effect.gen(function* () {
    const source = yield* ResolvedPtoolsConfigSource;
    const config = yield* source.load;

    const registryLayer = makeMcpRegistryLive(config.mcpServers);
    const executorLayer = CodeExecutorLayer({
      defaultTimeoutMs: Option.match(config.executor, {
        onNone: () => Option.none<number>(),
        onSome: (executor) => executor.defaultTimeoutMs,
      }),
    }).pipe(Layer.provide(ExecutorBackendLayer));

    return makeCodeModeLive().pipe(
      Layer.provide(Layer.merge(registryLayer, executorLayer)),
      Layer.catch(
        (error): Layer.Layer<CodeMode, ConfiguredHostContextError, never> =>
          Layer.unwrap(
            Effect.fail(toConfiguredHostContextError(error)),
          ) as Layer.Layer<CodeMode, ConfiguredHostContextError, never>,
      ),
    );
  }),
);

/**
 * Bind shared OAuth mechanics to the host URL policy. The provider factory uses
 * policy.callbackUrl rather than duplicating the `/hosts/:hostId/...` route
 * convention inside `@ptools/auth`.
 */
const ConfiguredAuthProviderAndPolicyLayer = McpOAuthProviderFactoryLayer.pipe(
  Layer.provideMerge(HostAuthCoordinatorPolicyLayer),
);

/** One in-memory auth state machine shared by route and MCP consumers. */
const ConfiguredAuthCoreLayer = AuthCoordinatorCore.layer.pipe(
  Layer.provide(ConfiguredAuthProviderAndPolicyLayer),
);

/**
 * Expose both auth audiences over the same core: `AuthCoordinator` for registry
 * lifecycle/status and `McpOAuthFlow` for browser authorization operations.
 */
const ConfiguredAuthLayer: Layer.Layer<
  AuthCoordinator | McpOAuthFlow,
  never,
  McpOAuthCredentialStore | McpOAuthStateStore | HostIdentity | HostPublicOrigin
> = Layer.merge(AuthCoordinator.layer, McpOAuthFlow.layer).pipe(
  Layer.provide(ConfiguredAuthCoreLayer),
);

/** Resolve the stored authored config through the stable configured stores. */
const ResolvedConfigSourceLayer = ResolvedPtoolsConfigSource.layer;
const ConfiguredCodeModeLayer = ConfiguredCodeModeLayerFromResolvedConfig.pipe(
  Layer.provide(ResolvedConfigSourceLayer),
  Layer.provide(ConfiguredAuthLayer),
);
const ConfiguredCodeModeServerLayer = CodeModeServerLayer.pipe(
  Layer.provide(ConfiguredCodeModeLayer),
);

/**
 * Config/origin-derived service graph for one configured host operation Context.
 *
 * Unlike `HostStableRuntimeLayer`, this is not long-lived per host instance.
 * `ConfiguredHostContextRunner` builds it on a cache miss for a given public
 * origin, using the current persisted config/secrets. Platform RPC/HTTP methods
 * should not construct it themselves — they enter through the runner.
 *
 * Provides: `CodeModeServer`, `CodeMode`, `AuthCoordinator`, `McpOAuthFlow`,
 * and `ResolvedPtoolsConfigSource`.
 *
 * Requires (supplied by the stable runtime + current binding):
 * - host-scoped stores/identity: config, secrets, OAuth credential/state stores,
 *   `HostIdentity`
 * - this Context's binding: `HostPublicOrigin`
 * - platform ports: `McpConnector`, `SandboxRuntime`
 */
export const ConfiguredHostContextLayer: Layer.Layer<
  ConfiguredHostOperationServices,
  ConfiguredHostContextError | ServerConfigError,
  | ConfiguredHostConfigStore
  | ConfiguredSecretStore
  | McpOAuthCredentialStore
  | McpOAuthStateStore
  | HostIdentity
  | HostPublicOrigin
  | McpConnector
  | SandboxRuntime
> = Layer.mergeAll(
  ConfiguredCodeModeServerLayer,
  ConfiguredCodeModeLayer,
  ConfiguredAuthLayer,
  ResolvedConfigSourceLayer,
);

const toConfiguredHostContextError = (
  cause:
    | AuthError
    | CredentialError
    | ExecutorStartError
    | ExecutorError
    | NameCollisionError
    | CodeModeError
    | unknown,
): ConfiguredHostContextError =>
  new ConfiguredHostContextError({
    message:
      cause instanceof ExecutorStartError
        ? `Failed to start configured host executor. ${cause.message}`
        : "Failed to build configured host context.",
    cause,
  });
