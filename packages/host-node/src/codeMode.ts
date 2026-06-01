import { resolve } from "node:path";
import { AuthError, CredentialError } from "@ptools/auth";
import {
  CodeMode,
  makeCodeModeLive,
  type CodeModeError,
} from "@ptools/code-mode";
import {
  CodeModeClient,
  CodeModeRemoteError,
  CodeModeServer,
  CodeModeServerFailure,
  type CodeModeClientError,
  type CodeModeClientHandle,
  type CodeModeRequest,
  type CodeModeResponse,
  type CodeModeServerError,
} from "@ptools/code-mode-api";
import {
  ConfigSource,
  ServerConfigError,
  type ResolvedPtoolsConfig,
} from "@ptools/config";
import {
  makeLocalSandboxExecutorLive,
  type ExecutorError,
  type LocalSandboxExecutorOptions,
} from "@ptools/executor";
import {
  makeMcpRegistryLive,
  type NameCollisionError,
  type UpstreamMcpServers,
} from "@ptools/mcp-registry";
import { Context, Data, Effect, Layer, ManagedRuntime } from "effect";
import {
  FileConfigSourceLive,
  NodeConfigSourceLive,
  ProcessEnvSecretResolverLive,
} from "./config.js";
import { NodeAuthCoordinatorLive, NodeCredentialsStoreLive } from "./auth.js";
import { NodeMcpConnectorLive } from "./mcpConnector.js";

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
  readonly mcpServers: UpstreamMcpServers;
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly auth?: NodeAuthOptions;
  readonly executor?: LocalSandboxExecutorOptions;
}

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
  makeCodeModeServerLive.pipe(
    Layer.provide(
      NodeCodeModeLiveFromResolvedConfig({
        hostId: options.hostId ?? DEFAULT_HOST_ID,
        config: {
          mcpServers: options.mcpServers,
          ...(options.executor === undefined
            ? {}
            : { executor: options.executor }),
        },
        env: options.env ?? process.env,
        cwd: options.cwd ?? process.cwd(),
        ...(options.auth === undefined ? {} : { auth: options.auth }),
      }),
    ),
  );

export const NodeCodeModeServerFromConfigFileLive = (
  path?: string,
  options: CreateNodeCodeModeFromConfigFileOptions = {},
): Layer.Layer<CodeModeServer, HostNodeError | ServerConfigError, never> =>
  makeCodeModeServerLive.pipe(
    Layer.provide(
      NodeCodeModeLiveFromConfigSource({
        hostId: options.hostId ?? DEFAULT_HOST_ID,
        env: options.env ?? process.env,
        cwd: options.cwd ?? process.cwd(),
        ...(options.auth === undefined ? {} : { auth: options.auth }),
      }).pipe(Layer.provide(makeConfigSourceLayer(path, options))),
    ),
  );

export const NodeCodeModeClientLive = (
  options: CreateNodeCodeModeOptions,
): Layer.Layer<CodeModeClient, HostNodeError, never> =>
  makeLocalCodeModeClientLive.pipe(
    Layer.provide(NodeCodeModeServerLive(options)),
  );

export const NodeCodeModeClientFromConfigFileLive = (
  path?: string,
  options: CreateNodeCodeModeFromConfigFileOptions = {},
): Layer.Layer<CodeModeClient, HostNodeError | ServerConfigError, never> =>
  makeLocalCodeModeClientLive.pipe(
    Layer.provide(NodeCodeModeServerFromConfigFileLive(path, options)),
  );

export const createNodeCodeModeClient = async (
  options: CreateNodeCodeModeOptions,
): Promise<CodeModeClientHandle> =>
  makeNodeCodeModeClientHandle(NodeCodeModeClientLive(options));

export const createNodeCodeModeClientFromConfigFile = async (
  path?: string,
  options: CreateNodeCodeModeFromConfigFileOptions = {},
): Promise<CodeModeClientHandle> =>
  makeNodeCodeModeClientHandle(
    NodeCodeModeClientFromConfigFileLive(path, options),
  );

const NodeCodeModeLiveFromResolvedConfig = (options: {
  readonly hostId: string;
  readonly config: ResolvedPtoolsConfig;
  readonly env: NodeEnv;
  readonly cwd: string;
  readonly auth?: NodeAuthOptions;
}): Layer.Layer<CodeMode, HostNodeError, never> =>
  makeCodeModeLive().pipe(
    Layer.provide(
      Layer.merge(
        makeMcpRegistryLive(options.config.mcpServers).pipe(
          Layer.provide(NodeMcpConnectorLive),
          Layer.provide(makeNodeAuthCoordinatorLive(options)),
        ),
        makeLocalSandboxExecutorLive(options.config.executor),
      ),
    ),
    Layer.mapError((cause) =>
      toHostNodeError("Failed to start local Node Code Mode.", cause),
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

const makeCodeModeServerLive: Layer.Layer<CodeModeServer, never, CodeMode> =
  Layer.effect(
    CodeModeServer,
    Effect.gen(function* () {
      const codeMode = yield* CodeMode;

      return {
        handle: (request: CodeModeRequest) =>
          handleCodeModeRequest(codeMode, request),
      };
    }),
  );

const makeLocalCodeModeClientLive: Layer.Layer<
  CodeModeClient,
  never,
  CodeModeServer
> = Layer.effect(
  CodeModeClient,
  Effect.gen(function* () {
    const server = yield* CodeModeServer;

    return {
      call: (request: CodeModeRequest) =>
        server.handle(request).pipe(Effect.mapError(toCodeModeClientError)),
    };
  }),
);

const handleCodeModeRequest = (
  codeMode: Context.Tag.Service<typeof CodeMode>,
  request: CodeModeRequest,
): Effect.Effect<CodeModeResponse, CodeModeServerError> => {
  switch (request.operation) {
    case "auth_status":
      return codeMode.authStatus.pipe(
        Effect.map((output) => ({ operation: "auth_status" as const, output })),
        Effect.mapError(toCodeModeServerFailure),
      );
    case "refresh":
      return codeMode.refresh.pipe(
        Effect.as({
          operation: "refresh" as const,
          output: { refreshed: true as const },
        }),
        Effect.mapError(toCodeModeServerFailure),
      );
    case "search_providers":
      return codeMode.searchProviders(request.input).pipe(
        Effect.map((output) => ({
          operation: "search_providers" as const,
          output,
        })),
        Effect.mapError(toCodeModeServerFailure),
      );
    case "search":
      return codeMode.search(request.input).pipe(
        Effect.map((output) => ({ operation: "search" as const, output })),
        Effect.mapError(toCodeModeServerFailure),
      );
    case "get_tool_schema":
      return codeMode.toolSchema(request.input).pipe(
        Effect.map((output) => ({
          operation: "get_tool_schema" as const,
          output,
        })),
        Effect.mapError(toCodeModeServerFailure),
      );
    case "execute":
      return codeMode.execute(request.input).pipe(
        Effect.map((output) => ({ operation: "execute" as const, output })),
        Effect.mapError(toCodeModeServerFailure),
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

const makeNodeCodeModeClientHandle = async <E>(
  layer: Layer.Layer<CodeModeClient, E, never>,
): Promise<CodeModeClientHandle> => {
  const managedRuntime = ManagedRuntime.make(layer);

  try {
    await managedRuntime.runtime();
    return {
      call: (request: CodeModeRequest) =>
        managedRuntime.runPromise(
          Effect.gen(function* () {
            const client = yield* CodeModeClient;

            return yield* client.call(request);
          }),
        ),
      close: () => managedRuntime.dispose(),
    };
  } catch (cause) {
    await managedRuntime.dispose();
    throw cause;
  }
};

const toCodeModeServerFailure = (cause: CodeModeError): CodeModeServerFailure =>
  new CodeModeServerFailure({
    message: "Code Mode request failed.",
    cause,
  });

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
