import { resolve } from "node:path";
import { AuthError, CredentialError } from "@ptools/auth";
import {
  CodeMode,
  CodeModeServerLayer,
  makeCodeModeLive,
  type CodeModeError,
} from "@ptools/code-mode";
import {
  CodeModeRemoteError,
  type CodeModeClientError,
  type CodeModeClientHandle,
  type CodeModeRequest,
  type CodeModeServerError,
} from "@ptools/code-mode-api";
import { CodeModeClient, CodeModeServer } from "@ptools/code-mode-api/effect";
import {
  makeHostOperationProtocolFailureResponse,
  type HostClientHandle,
} from "@ptools/host-api";
import {
  HostClient,
  HostClientLayer,
  HostServer,
  HostTransport,
  HostTransportError,
  HostTransportCodeModeClientLayer,
} from "@ptools/host-api/effect";
import type {
  HostOperationRequest,
  HostOperationResponse,
} from "@ptools/host-api";
import {
  ConfigSource,
  ResolvedExecutorConfig,
  ResolvedHttpMcpAuthConfig,
  ResolvedHttpMcpConfig,
  ResolvedPtoolsConfig,
  ResolvedStdioMcpConfig,
  ServerConfigError,
} from "@ptools/config";
import { ExecutorStartError, type ExecutorError } from "@ptools/executor";
import {
  makeMcpRegistryLive,
  type NameCollisionError,
  type UpstreamMcpServers,
} from "@ptools/mcp-registry";
import { Context, Data, Effect, Layer, ManagedRuntime, Option } from "effect";
import {
  FileConfigSourceLive,
  NodeConfigSourceLive,
  ProcessEnvSecretResolverLive,
} from "./config.js";
import { NodeAuthCoordinatorLive, NodeCredentialsStoreLive } from "./auth.js";
import { NodeMcpConnectorLive } from "./mcpConnector.js";
import {
  LocalSandboxExecutorLayer,
  type LocalSandboxExecutorOptions,
} from "./executor/localExecutor.js";

const DEFAULT_HOST_ID = "node-local";
const DEFAULT_AUTH_SERVICE_NAME = "ptools-mcp-oauth";

type NodeEnv = Readonly<Record<string, string | undefined>>;

export class HostNodeError extends Data.TaggedError("HostNodeError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface NodeAuthOptions {
  readonly serviceName?: string;
  readonly autoOpen?: boolean;
}

export interface CreateNodeCodeModeOptions {
  readonly hostId?: string;
  readonly mcpServers: Readonly<Record<string, NodeUpstreamMcpConfig>>;
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly auth?: NodeAuthOptions;
  readonly executor?: LocalSandboxExecutorOptions;
}

export type NodeUpstreamMcpConfig =
  | {
      readonly transport: "stdio";
      readonly command: string;
      readonly args?: ReadonlyArray<string>;
      readonly env?: Readonly<Record<string, string>>;
      readonly cwd?: string;
    }
  | {
      readonly transport: "http";
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly auth?: {
        readonly type: "oauth";
        readonly scope?: string;
        readonly resourceMetadataUrl?: string;
        readonly clientId?: string;
        readonly clientSecret?: string;
        readonly clientMetadataUrl?: string;
        readonly redirectUri?: string;
      };
    };

export interface CreateNodeCodeModeFromConfigFileOptions {
  readonly argv?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly hostId?: string;
  readonly auth?: NodeAuthOptions;
}

export type { CodeModeClientHandle };

export const NodeCodeModeServerLive = (
  options: CreateNodeCodeModeOptions,
): Layer.Layer<CodeModeServer, HostNodeError, never> =>
  CodeModeServerLayer.pipe(
    Layer.provide(
      NodeCodeModeLiveFromResolvedConfig({
        hostId: options.hostId ?? DEFAULT_HOST_ID,
        config: ResolvedPtoolsConfig.make({
          mcpServers: resolvePublicMcpServers(options.mcpServers),
          executor: Option.fromNullable(options.executor).pipe(
            Option.map((executor) =>
              ResolvedExecutorConfig.make({
                defaultTimeoutMs: Option.fromNullable(
                  executor.defaultTimeoutMs,
                ),
              }),
            ),
          ),
        }),
        env: options.env ?? process.env,
        cwd: options.cwd ?? process.cwd(),
        ...(options.executor?.denoExecutable === undefined
          ? {}
          : { denoExecutable: options.executor.denoExecutable }),
        ...(options.auth === undefined ? {} : { auth: options.auth }),
      }),
    ),
  );

const resolvePublicMcpServers = (
  servers: Readonly<Record<string, NodeUpstreamMcpConfig>>,
): UpstreamMcpServers =>
  Object.fromEntries(
    Object.entries(servers).map(([name, config]) => [
      name,
      config.transport === "stdio"
        ? ResolvedStdioMcpConfig.make({
            command: config.command,
            args: Option.fromNullable(config.args),
            env: Option.fromNullable(config.env),
            cwd: Option.fromNullable(config.cwd),
          })
        : ResolvedHttpMcpConfig.make({
            url: config.url,
            headers: Option.fromNullable(config.headers),
            auth: Option.fromNullable(config.auth).pipe(
              Option.map((auth) =>
                ResolvedHttpMcpAuthConfig.make({
                  type: "oauth",
                  scope: Option.fromNullable(auth.scope),
                  resourceMetadataUrl: Option.fromNullable(
                    auth.resourceMetadataUrl,
                  ),
                  clientId: Option.fromNullable(auth.clientId),
                  clientSecret: Option.fromNullable(auth.clientSecret),
                  clientMetadataUrl: Option.fromNullable(
                    auth.clientMetadataUrl,
                  ),
                  redirectUri: Option.fromNullable(auth.redirectUri),
                }),
              ),
            ),
          }),
    ]),
  );

export const NodeCodeModeServerFromConfigFileLive = (
  path?: string,
  options: CreateNodeCodeModeFromConfigFileOptions = {},
): Layer.Layer<CodeModeServer, HostNodeError | ServerConfigError, never> =>
  CodeModeServerLayer.pipe(
    Layer.provide(
      NodeCodeModeLiveFromConfigSource({
        hostId: options.hostId ?? DEFAULT_HOST_ID,
        env: options.env ?? process.env,
        cwd: options.cwd ?? process.cwd(),
        ...(options.auth === undefined ? {} : { auth: options.auth }),
      }).pipe(Layer.provide(makeConfigSourceLayer(path, options))),
    ),
  );

export const NodeHostServerLive = (
  options: CreateNodeCodeModeOptions,
): Layer.Layer<HostServer, HostNodeError, never> =>
  makeNodeHostServerLive.pipe(Layer.provide(NodeCodeModeServerLive(options)));

export const NodeHostServerFromConfigFileLive = (
  path?: string,
  options: CreateNodeCodeModeFromConfigFileOptions = {},
): Layer.Layer<HostServer, HostNodeError | ServerConfigError, never> =>
  makeNodeHostServerLive.pipe(
    Layer.provide(NodeCodeModeServerFromConfigFileLive(path, options)),
  );

export const NodeInProcessHostTransportLive: Layer.Layer<
  HostTransport,
  never,
  HostServer
> = Layer.effect(
  HostTransport,
  Effect.gen(function* () {
    const server = yield* HostServer;

    return {
      call: (request: HostOperationRequest) =>
        server.handle(request).pipe(
          Effect.mapError(
            (cause) =>
              new HostTransportError({
                message: "Node in-process host server failed.",
                cause,
              }),
          ),
        ),
    };
  }),
);

export const NodeHostClientLive = (
  options: CreateNodeCodeModeOptions,
): Layer.Layer<HostClient | CodeModeClient, HostNodeError, never> =>
  HostClientLayer.pipe(
    Layer.provide(NodeInProcessHostTransportLive),
    Layer.provide(NodeHostServerLive(options)),
  );

export const NodeHostClientFromConfigFileLive = (
  path?: string,
  options: CreateNodeCodeModeFromConfigFileOptions = {},
): Layer.Layer<
  HostClient | CodeModeClient,
  HostNodeError | ServerConfigError,
  never
> =>
  HostClientLayer.pipe(
    Layer.provide(NodeInProcessHostTransportLive),
    Layer.provide(NodeHostServerFromConfigFileLive(path, options)),
  );

export const NodeCodeModeClientLive = (
  options: CreateNodeCodeModeOptions,
): Layer.Layer<CodeModeClient, HostNodeError, never> =>
  HostTransportCodeModeClientLayer.pipe(
    Layer.provide(NodeInProcessHostTransportLive),
    Layer.provide(NodeHostServerLive(options)),
  );

export const NodeCodeModeClientFromConfigFileLive = (
  path?: string,
  options: CreateNodeCodeModeFromConfigFileOptions = {},
): Layer.Layer<CodeModeClient, HostNodeError | ServerConfigError, never> =>
  HostTransportCodeModeClientLayer.pipe(
    Layer.provide(NodeInProcessHostTransportLive),
    Layer.provide(NodeHostServerFromConfigFileLive(path, options)),
  );

export const createNodeHostClient = async (
  options: CreateNodeCodeModeOptions,
): Promise<HostClientHandle> =>
  makeNodeHostClientHandle(NodeHostClientLive(options));

export const createNodeHostClientFromConfigFile = async (
  path?: string,
  options: CreateNodeCodeModeFromConfigFileOptions = {},
): Promise<HostClientHandle> =>
  makeNodeHostClientHandle(NodeHostClientFromConfigFileLive(path, options));

export const createNodeCodeModeClient = async (
  options: CreateNodeCodeModeOptions,
): Promise<CodeModeClientHandle> =>
  (await createNodeHostClient(options)).codeMode;

export const createNodeCodeModeClientFromConfigFile = async (
  path?: string,
  options: CreateNodeCodeModeFromConfigFileOptions = {},
): Promise<CodeModeClientHandle> =>
  (await createNodeHostClientFromConfigFile(path, options)).codeMode;

const NodeCodeModeLiveFromResolvedConfig = (options: {
  readonly hostId: string;
  readonly config: ResolvedPtoolsConfig;
  readonly env: NodeEnv;
  readonly cwd: string;
  readonly denoExecutable?: string;
  readonly auth?: NodeAuthOptions;
}): Layer.Layer<CodeMode, HostNodeError, never> =>
  makeCodeModeLive().pipe(
    Layer.provide(
      Layer.merge(
        makeMcpRegistryLive(options.config.mcpServers).pipe(
          Layer.provide(NodeMcpConnectorLive),
          Layer.provide(makeNodeAuthCoordinatorLive(options)),
        ),
        LocalSandboxExecutorLayer({
          ...Option.match(options.config.executor, {
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
        }),
      ),
    ),
    Layer.mapError((cause) =>
      toHostNodeError(
        cause instanceof ExecutorStartError
          ? `Failed to start local Node Code Mode. ${cause.message}`
          : "Failed to start local Node Code Mode.",
        cause,
      ),
    ),
  );

const NodeCodeModeLiveFromConfigSource = (options: {
  readonly hostId: string;
  readonly env: NodeEnv;
  readonly cwd: string;
  readonly auth?: NodeAuthOptions;
}): Layer.Layer<CodeMode, HostNodeError | ServerConfigError, ConfigSource> =>
  Layer.unwrapEffect(
    Effect.gen(function* () {
      const source = yield* ConfigSource;
      const config = yield* source.load;

      return NodeCodeModeLiveFromResolvedConfig({
        ...options,
        config,
      });
    }),
  );

const makeNodeHostServerLive: Layer.Layer<HostServer, never, CodeModeServer> =
  Layer.effect(
    HostServer,
    Effect.gen(function* () {
      const codeModeServer = yield* CodeModeServer;

      return {
        handle: (request: HostOperationRequest) =>
          handleNodeHostRequest(codeModeServer, request),
      };
    }),
  );

const handleNodeHostRequest = (
  codeModeServer: Context.Tag.Service<typeof CodeModeServer>,
  request: HostOperationRequest,
): Effect.Effect<HostOperationResponse, never> => {
  switch (request.operation) {
    case "code_mode":
      return codeModeServer.handle(request.input).pipe(
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
    default:
      return Effect.succeed(
        makeHostOperationProtocolFailureResponse({
          code: "unknown_operation",
          message: `Node host does not implement ${request.operation}.`,
        }),
      );
  }
};

const makeNodeAuthCoordinatorLive = (options: {
  readonly hostId: string;
  readonly env: NodeEnv;
  readonly auth?: NodeAuthOptions;
}) =>
  NodeAuthCoordinatorLive(
    optionalAutoOpen(
      {
        runtimeId: options.hostId,
      },
      resolveAutoOpen(options.env, options.auth),
    ),
  ).pipe(
    Layer.provide(
      NodeCredentialsStoreLive({
        serviceName: options.auth?.serviceName ?? DEFAULT_AUTH_SERVICE_NAME,
      }),
    ),
  );

const optionalAutoOpen = (
  options: { readonly runtimeId: string },
  autoOpen: boolean | undefined,
): { readonly runtimeId: string; readonly autoOpen?: boolean } =>
  autoOpen === undefined ? options : { ...options, autoOpen };

const resolveAutoOpen = (
  env: NodeEnv,
  auth: NodeAuthOptions | undefined,
): boolean | undefined => {
  if (auth?.autoOpen !== undefined) {
    return auth.autoOpen;
  }

  return (
    env.PTOOLS_AUTH_AUTO_OPEN !== "0" &&
    env.PTOOLS_AUTH_AUTO_OPEN !== "false" &&
    process.stderr.isTTY === true
  );
};

const makeConfigSourceLayer = (
  path: string | undefined,
  options: CreateNodeCodeModeFromConfigFileOptions,
): Layer.Layer<ConfigSource, ServerConfigError, never> => {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  if (path === undefined) {
    return NodeConfigSourceLive({
      argv: options.argv ?? [],
      env,
      cwd,
    });
  }

  return FileConfigSourceLive({
    path: resolve(cwd, path),
  }).pipe(Layer.provide(ProcessEnvSecretResolverLive({ env })));
};

const makeNodeHostClientHandle = async <E>(
  layer: Layer.Layer<HostClient | CodeModeClient, E, never>,
): Promise<HostClientHandle> => {
  const managedRuntime = ManagedRuntime.make(layer);

  try {
    await managedRuntime.runtime();
    const close = () => managedRuntime.dispose();

    return {
      call: (request: HostOperationRequest) =>
        managedRuntime.runPromise(
          Effect.gen(function* () {
            const client = yield* HostClient;

            return yield* client.call(request);
          }),
        ),
      codeMode: {
        call: (request: CodeModeRequest) =>
          managedRuntime.runPromise(
            Effect.gen(function* () {
              const client = yield* CodeModeClient;

              return yield* client.call(request);
            }),
          ),
        close,
      },
      close,
    };
  } catch (cause) {
    await managedRuntime.dispose();
    throw cause;
  }
};

const toCodeModeClientError = (
  cause: CodeModeServerError,
): CodeModeClientError =>
  new CodeModeRemoteError({
    message: "Local Code Mode server request failed.",
    cause,
  });

const toHostNodeError = (
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
