import {
  CodeModeSearchProvidersRequest,
  type CodeModeClientHandle,
  type CodeModeRequest,
} from "@ptools/code-mode-api";
import { CodeModeClient } from "@ptools/code-mode-api/effect";
import {
  makeHostOperationProtocolFailureResponse,
  type HostClientHandle,
  type HostOperationRequest,
  type HostOperationResponse,
} from "@ptools/host-api";
import { HostHttpClient } from "@ptools/host-api/effect";
import { Context, Effect, Layer, ManagedRuntime, Option } from "effect";
import {
  NodeCodeModeClientLive,
  NodeLocalHostHttpClientLive,
  makeNodeHostHttpClientWithCodeModeLive,
} from "./hostHttp.js";
import {
  HostNodeError,
  type NodeCodeModeHostOptions,
} from "./options.js";

/** Promise SDK host handle backed by Node's configured shared Host HttpApi. */
export const createNodeHostClient = async (
  configPath?: string,
  options: NodeCodeModeHostOptions = {},
): Promise<HostClientHandle> =>
  makeNodeHostHttpClientHandle(
    makeNodeHostHttpClientWithCodeModeLive(
      NodeLocalHostHttpClientLive(configPath, options),
    ),
  );

/** Promise CodeMode handle backed by Node's configured shared Host HttpApi. */
export const createNodeCodeModeClient = async (
  configPath?: string,
  options: NodeCodeModeHostOptions = {},
): Promise<CodeModeClientHandle> =>
  makeNodeCodeModeClientHandle(
    NodeCodeModeClientLive(configPath, options),
  );

const makeNodeHostHttpClientHandle = async <E>(
  layer: Layer.Layer<HostHttpClient | CodeModeClient, E, never>,
): Promise<HostClientHandle> => {
  const managedRuntime = ManagedRuntime.make(layer);

  try {
    await managedRuntime.runtime();
    await warmNodeCodeModeClient(managedRuntime);
    const close = () => managedRuntime.dispose();

    return {
      call: (request: HostOperationRequest) =>
        managedRuntime.runPromise(
          Effect.gen(function* () {
            const host = yield* HostHttpClient;

            return yield* callNodeHostHttpClient(host, request);
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

const callNodeHostHttpClient = (
  host: Context.Tag.Service<typeof HostHttpClient>,
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
      return host.startMcpAuth({
        serverName: request.input.serverName,
        force: request.input.force,
      });
    case "complete_mcp_oauth_callback":
      return Effect.succeed(
        makeHostOperationProtocolFailureResponse({
          code: "unknown_operation",
          message: "Node Host HTTP client does not call browser OAuth callbacks.",
        }),
      );
  }
};

const makeNodeCodeModeClientHandle = async <E>(
  layer: Layer.Layer<CodeModeClient, E, never>,
): Promise<CodeModeClientHandle> => {
  const managedRuntime = ManagedRuntime.make(layer);

  try {
    await managedRuntime.runtime();
    await warmNodeCodeModeClient(managedRuntime);
    const close = () => managedRuntime.dispose();

    return {
      call: (request: CodeModeRequest) =>
        managedRuntime.runPromise(
          Effect.gen(function* () {
            const client = yield* CodeModeClient;

            return yield* client.call(request);
          }),
        ),
      close,
    };
  } catch (cause) {
    await managedRuntime.dispose();
    throw cause;
  }
};

const warmNodeCodeModeClient = async <R>(
  runtime: ManagedRuntime.ManagedRuntime<R | CodeModeClient, unknown>,
): Promise<void> => {
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* CodeModeClient;
        yield* client.call({
          operation: "search_providers",
          input: CodeModeSearchProvidersRequest.make({
            query: Option.none(),
            limit: Option.none(),
          }),
        });
      }),
    );
  } catch (cause) {
    const hostNodeError = findHostNodeError(cause);
    if (hostNodeError !== undefined) {
      throw hostNodeError;
    }

    const responseBody = await findHttpResponseErrorBody(cause);
    if (responseBody?.startsWith("Failed to start local Node Code Mode.") === true) {
      throw new HostNodeError({ message: responseBody, cause });
    }

    throw cause;
  }
};

const findHostNodeError = (
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): HostNodeError | undefined => {
  if (value instanceof HostNodeError) {
    return value;
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

const findHttpResponseErrorBody = async (
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): Promise<string | undefined> => {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return undefined;
  }

  seen.add(value);

  if ((value as { readonly _tag?: unknown })._tag === "ResponseError") {
    const response = (value as {
      readonly response?: { readonly original?: { readonly source?: unknown } };
    }).response?.original?.source;

    if (response instanceof Response) {
      return response.clone().text();
    }
  }

  for (const key of [
    ...Object.keys(value),
    ...Object.getOwnPropertySymbols(value),
  ]) {
    const nested = await findHttpResponseErrorBody(
      (value as Record<PropertyKey, unknown>)[key],
      seen,
    );

    if (nested !== undefined) {
      return nested;
    }
  }

  return undefined;
};
