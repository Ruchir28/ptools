import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type CodeModeClientError,
  type CodeModeResponse,
  CodeModeExecuteRequest,
  CodeModeSearchProvidersRequest,
  CodeModeSearchRequest,
  CodeModeToolSchemaRequest,
} from "@ptools/code-mode-api";
import { CodeModeClient } from "@ptools/code-mode-api/effect";
import {
  collectUserPtoolsConfigEnvReferences,
  DEFAULT_CONFIG_PATHS,
  normalizeUserPtoolsConfigStdioCwds,
  parseUserPtoolsConfigJson,
} from "@ptools/config";
import { startEmbeddedNodeHost, NODE_LOCAL_HOST_ID } from "@ptools/host-node";
import { Context, Data, Effect, Result, Option, Scope } from "effect";
import { createServer as createViteServer, type ViteDevServer } from "vite";

export class PlaygroundServerError extends Data.TaggedError(
  "PlaygroundServerError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface PlaygroundServerOptions {
  readonly port: number;
  readonly configPath: string;
  readonly vite?: ViteDevServer;
}

export interface StartedPlaygroundServer {
  readonly url: string;
  readonly port: number;
}

/**
 * Starts the browser playground for a configured Code Mode runtime.
 *
 * @param argv Command-line args after executable and script path.
 * @param env Environment map used for config path, secrets, and port.
 * @param cwd Directory used to resolve relative config paths.
 * @returns An Effect that stays alive until stdin closes or the process exits.
 */
export const runPlayground = (
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Effect.Effect<void, unknown> =>
  Effect.scoped(
    Effect.gen(function* () {
      const port = yield* resolvePlaygroundPort(argv, env);
      const configPath = yield* Effect.tryPromise(() =>
        resolveAuthoredConfigPath(parseArgValue(argv, "--config"), env, cwd),
      );
      const raw = yield* Effect.tryPromise(() => readFile(configPath, "utf8"));
      const decoded = yield* parseUserPtoolsConfigJson(raw, configPath);
      const config = normalizeUserPtoolsConfigStdioCwds(decoded, (stdioCwd) =>
        resolve(dirname(configPath), stdioCwd),
      );
      const secrets = yield* Effect.forEach(
        collectUserPtoolsConfigEnvReferences(config),
        (name) =>
          Effect.fromNullishOr(env[name]).pipe(
            Effect.mapError(
              () =>
                new PlaygroundServerError({
                  message: `Missing environment variable ${name} referenced by ${configPath}.`,
                }),
            ),
            Effect.map((value) => [name, value] as const),
          ),
      ).pipe(Effect.map(Object.fromEntries));
      const host = yield* Effect.acquireRelease(
        Effect.tryPromise(() =>
          startEmbeddedNodeHost({
            hostId: NODE_LOCAL_HOST_ID,
            ...(nonEmpty(env.PTOOLS_HOME) === undefined
              ? {}
              : {
                  internalStateDirectory: resolve(
                    nonEmpty(env.PTOOLS_HOME)!,
                    "state",
                  ),
                }),
          }),
        ),
        (handle) => Effect.promise(() => handle.close()).pipe(Effect.ignore),
      );

      yield* callHostSetup(() =>
        host.call({ operation: "configure", input: { config } }),
      );
      yield* callHostSetup(() =>
        host.call({ operation: "configure_secrets", input: { secrets } }),
      );

      const codeMode = CodeModeClient.of({
        call: (request) =>
          Effect.tryPromise({
            try: () => host.codeMode.call(request),
            catch: (cause) => cause as CodeModeClientError,
          }),
      });
      yield* runPlaygroundHttp({ configPath, port }).pipe(
        Effect.provideService(CodeModeClient, codeMode),
      );
    }),
  );

/**
 * Starts the HTTP playground and keeps it running inside the current scope.
 *
 * @param options Port and config path label to show in startup output.
 * @returns Started server metadata.
 */
export const startPlaygroundServer = (
  options: PlaygroundServerOptions,
): Effect.Effect<
  StartedPlaygroundServer,
  PlaygroundServerError,
  CodeModeClient | Scope.Scope
> =>
  Effect.gen(function* () {
    const codeMode = yield* CodeModeClient;
    const services = yield* Effect.context<never>();
    const server = createServer();

    server.on("request", (request, response) => {
      void Effect.runPromiseWith(services)(
        handleRequest(codeMode, request, response, options.vite),
      );
    });

    const address = yield* Effect.acquireRelease(
      listen(server, options.port),
      () => closeServer(server).pipe(Effect.ignore),
    );
    const port = address.port;

    return {
      port,
      url: `http://127.0.0.1:${port}`,
    };
  });

const runPlaygroundHttp = (
  options: PlaygroundServerOptions,
): Effect.Effect<void, PlaygroundServerError, CodeModeClient | Scope.Scope> =>
  Effect.gen(function* () {
    const vite = yield* makeViteDevServer;
    const started = yield* startPlaygroundServer({ ...options, vite });

    yield* Effect.sync(() => {
      process.stderr.write(
        `[ptools] playground running at ${started.url}\n[ptools] config: ${options.configPath}\n`,
      );
    });

    yield* waitForProcessClose;
  });

const handleRequest = (
  codeMode: Context.Service.Shape<typeof CodeModeClient>,
  request: IncomingMessage,
  response: ServerResponse,
  vite?: ViteDevServer,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method === "OPTIONS") {
      return yield* sendEmpty(response, 204);
    }

    if (request.method === "GET" && url.pathname === "/api/context") {
      const query = url.searchParams.get("query")?.trim();
      const context =
        query === undefined || query.length === 0
          ? yield* codeMode
              .call({
                operation: "search_providers",
                input: CodeModeSearchProvidersRequest.make({
                  query: Option.none(),
                  limit: Option.none(),
                }),
              })
              .pipe(
                Effect.flatMap(expectCodeModeOutput("search_providers")),
                Effect.map(toPlaygroundContext),
                Effect.mapError(toErrorBody),
                Effect.result,
              )
          : yield* codeMode
              .call({
                operation: "search",
                input: CodeModeSearchRequest.make({
                  query,
                  provider: Option.none(),
                  limit: Option.none(),
                }),
              })
              .pipe(
                Effect.flatMap(expectCodeModeOutput("search")),
                Effect.map(toPlaygroundContext),
                Effect.mapError(toErrorBody),
                Effect.result,
              );

      if (Result.isFailure(context)) {
        return yield* sendJson(response, 500, context.failure);
      }

      return yield* sendJson(response, 200, {
        context: context.success,
        summary: summarizeContext(context.success),
      });
    }

    if (request.method === "POST" && url.pathname === "/api/tool-schema") {
      const parsed = yield* readToolSchemaRequest(request).pipe(Effect.result);

      if (Result.isFailure(parsed)) {
        return yield* sendJson(response, 400, toErrorBody(parsed.failure));
      }

      const result = yield* codeMode
        .call({ operation: "get_tool_schema", input: parsed.success })
        .pipe(
          Effect.flatMap(expectCodeModeOutput("get_tool_schema")),
          Effect.result,
        );

      if (Result.isFailure(result)) {
        return yield* sendJson(response, 500, toErrorBody(result.failure));
      }

      return yield* sendJson(response, 200, result.success);
    }

    if (request.method === "POST" && url.pathname === "/api/execute") {
      const parsed = yield* readExecuteRequest(request).pipe(Effect.result);

      if (Result.isFailure(parsed)) {
        return yield* sendJson(response, 400, toErrorBody(parsed.failure));
      }

      const result = yield* codeMode
        .call({ operation: "execute", input: parsed.success })
        .pipe(Effect.flatMap(expectCodeModeOutput("execute")), Effect.result);

      if (Result.isFailure(result)) {
        return yield* sendJson(response, 500, toErrorBody(result.failure));
      }

      return yield* sendJson(response, 200, result.success);
    }

    if (request.method === "GET" || request.method === "HEAD") {
      return yield* serveClient(request, response, vite);
    }

    return yield* sendJson(response, 404, { error: "Not found" });
  }).pipe(
    Effect.catch((cause) =>
      sendJson(response, 500, toErrorBody(cause)).pipe(
        Effect.catch(() => Effect.void),
      ),
    ),
  );

type CodeModeOutput<Operation extends CodeModeResponse["operation"]> = Extract<
  CodeModeResponse,
  { readonly operation: Operation }
>["output"];

/** Preserve the request/response discriminator invariant at the client seam. */
const expectCodeModeOutput =
  <Operation extends CodeModeResponse["operation"]>(operation: Operation) =>
  (
    response: CodeModeResponse,
  ): Effect.Effect<CodeModeOutput<Operation>, PlaygroundServerError> =>
    (response.operation === operation
      ? Effect.succeed(response.output)
      : Effect.fail(
          new PlaygroundServerError({
            message: `Expected Code Mode ${operation} response, received ${response.operation}.`,
          }),
        )) as Effect.Effect<CodeModeOutput<Operation>, PlaygroundServerError>;

const summarizeContext = (context: {
  readonly servers: ReadonlyArray<{
    readonly tools: ReadonlyArray<unknown>;
  }>;
  readonly diagnostics: ReadonlyArray<unknown>;
}): {
  readonly serverCount: number;
  readonly toolCount: number;
  readonly diagnosticCount: number;
} => ({
  serverCount: context.servers.length,
  toolCount: context.servers.reduce(
    (sum, server) => sum + server.tools.length,
    0,
  ),
  diagnosticCount: context.diagnostics.length,
});

const toPlaygroundContext = (
  result:
    | {
        readonly providers: ReadonlyArray<{
          readonly provider: string;
          readonly displayName: string;
        }>;
        readonly diagnostics: ReadonlyArray<unknown>;
      }
    | {
        readonly actions: ReadonlyArray<{
          readonly toolId: string;
          readonly provider: string;
          readonly action: string;
          readonly title?: string | undefined;
          readonly description?: string | undefined;
        }>;
        readonly diagnostics: ReadonlyArray<unknown>;
      },
) => {
  if ("providers" in result) {
    return {
      servers: result.providers.map((provider) => ({
        serverName: provider.displayName,
        jsServerName: provider.provider,
        tools: [],
      })),
      diagnostics: result.diagnostics,
    };
  }

  const servers = new Map<
    string,
    {
      readonly serverName: string;
      readonly jsServerName: string;
      readonly tools: Array<{
        readonly originalToolName: string;
        readonly jsToolName: string;
        readonly title?: string;
        readonly description?: string;
        readonly inputSchemaAvailable: true;
      }>;
    }
  >();

  for (const action of result.actions) {
    const existing =
      servers.get(action.provider) ??
      ({
        serverName: action.provider,
        jsServerName: action.provider,
        tools: [],
      } satisfies {
        readonly serverName: string;
        readonly jsServerName: string;
        readonly tools: Array<{
          readonly originalToolName: string;
          readonly jsToolName: string;
          readonly title?: string;
          readonly description?: string;
          readonly inputSchemaAvailable: true;
        }>;
      });

    existing.tools.push({
      originalToolName: action.action,
      jsToolName: action.action,
      ...(action.title === undefined ? {} : { title: action.title }),
      ...(action.description === undefined
        ? {}
        : { description: action.description }),
      inputSchemaAvailable: true,
    });
    servers.set(action.provider, existing);
  }

  return {
    servers: [...servers.values()],
    diagnostics: result.diagnostics,
  };
};

const callHostSetup = (
  operation: () => Promise<unknown>,
): Effect.Effect<void, unknown> =>
  Effect.tryPromise(operation).pipe(
    Effect.flatMap((response) => {
      if (typeof response !== "object" || response === null) {
        return Effect.fail(
          new PlaygroundServerError({
            message: "Host returned an invalid setup response.",
          }),
        );
      }
      if (
        "result" in response &&
        typeof response.result === "object" &&
        response.result !== null &&
        "ok" in response.result &&
        response.result.ok === true
      ) {
        return Effect.void;
      }
      const message = findResponseErrorMessage(response);
      return Effect.fail(
        new PlaygroundServerError({
          message: message ?? "Host setup operation failed.",
        }),
      );
    }),
  );

const findResponseErrorMessage = (response: object): string | undefined => {
  for (const container of [
    "error" in response ? response.error : undefined,
    "result" in response &&
    typeof response.result === "object" &&
    response.result !== null &&
    "error" in response.result
      ? response.result.error
      : undefined,
  ]) {
    if (
      typeof container === "object" &&
      container !== null &&
      "message" in container &&
      typeof container.message === "string"
    )
      return container.message;
  }
  return undefined;
};

const resolveAuthoredConfigPath = async (
  explicitPath: string | undefined,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<string> => {
  const selected = explicitPath ?? nonEmpty(env.PTOOLS_CONFIG);
  if (selected !== undefined) {
    return isAbsolute(selected) ? selected : resolve(cwd, selected);
  }
  for (const candidate of DEFAULT_CONFIG_PATHS) {
    const absolute = resolve(cwd, candidate);
    if (await fileExists(absolute)) return absolute;
  }
  throw new Error(
    `No ptools config found. Pass --config <path> or create ${DEFAULT_CONFIG_PATHS.join(" or ")}.`,
  );
};

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === "" ? undefined : value;

const fileExists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const resolvePlaygroundPort = (
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Effect.Effect<number, PlaygroundServerError> => {
  const value = parseArgValue(argv, "--port") ?? env.PTOOLS_PLAYGROUND_PORT;

  if (value === undefined || value.trim().length === 0) {
    return Effect.succeed(5178);
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    return Effect.fail(
      new PlaygroundServerError({
        message: `Invalid playground port: ${value}`,
      }),
    );
  }

  return Effect.succeed(parsed);
};

const parseArgValue = (
  argv: ReadonlyArray<string>,
  flag: string,
): string | undefined => {
  const equalsArg = argv.find((arg) => arg.startsWith(`${flag}=`));

  if (equalsArg !== undefined) {
    return equalsArg.slice(flag.length + 1);
  }

  const index = argv.indexOf(flag);

  return index === -1 ? undefined : argv[index + 1];
};

const readExecuteRequest = (
  request: IncomingMessage,
): Effect.Effect<CodeModeExecuteRequest, PlaygroundServerError> =>
  readJson(request).pipe(
    Effect.flatMap((body) => {
      const candidate = body as {
        readonly code?: unknown;
        readonly timeoutMs?: unknown;
      };

      if (
        typeof body !== "object" ||
        body === null ||
        !("code" in body) ||
        typeof candidate.code !== "string" ||
        candidate.code.trim().length === 0
      ) {
        return Effect.fail(
          new PlaygroundServerError({
            message: "Execute request requires a non-empty code string.",
          }),
        );
      }

      const timeoutMs = candidate.timeoutMs;

      if (
        timeoutMs !== undefined &&
        (typeof timeoutMs !== "number" ||
          !Number.isFinite(timeoutMs) ||
          timeoutMs <= 0)
      ) {
        return Effect.fail(
          new PlaygroundServerError({
            message: "Execute request timeoutMs must be a positive number.",
          }),
        );
      }

      return Effect.succeed(
        CodeModeExecuteRequest.make({
          code: candidate.code,
          timeoutMs: Option.fromNullishOr(timeoutMs),
        }),
      );
    }),
  );

const readToolSchemaRequest = (
  request: IncomingMessage,
): Effect.Effect<CodeModeToolSchemaRequest, PlaygroundServerError> =>
  readJson(request).pipe(
    Effect.flatMap((body) => {
      const candidate = body as {
        readonly toolIds?: unknown;
      };

      if (
        typeof body !== "object" ||
        body === null ||
        !Array.isArray(candidate.toolIds)
      ) {
        return Effect.fail(
          new PlaygroundServerError({
            message: "Tool schema request requires a toolIds array.",
          }),
        );
      }

      const toolIds: Array<string> = [];

      for (const toolId of candidate.toolIds) {
        if (typeof toolId !== "string" || toolId.trim().length === 0) {
          return Effect.fail(
            new PlaygroundServerError({
              message: "Each requested toolId must be a non-empty string.",
            }),
          );
        }

        toolIds.push(toolId.trim());
      }

      return Effect.succeed(CodeModeToolSchemaRequest.make({ toolIds }));
    }),
  );

const makeViteDevServer: Effect.Effect<
  ViteDevServer,
  PlaygroundServerError,
  Scope.Scope
> = Effect.acquireRelease(
  Effect.tryPromise({
    try: () =>
      createViteServer({
        appType: "spa",
        root: getPlaygroundRoot(),
        server: {
          middlewareMode: true,
        },
      }),
    catch: (cause) =>
      new PlaygroundServerError({
        message: "Unable to start Vite middleware.",
        cause,
      }),
  }),
  (vite) => Effect.tryPromise(() => vite.close()).pipe(Effect.ignore),
);

const serveClient = (
  request: IncomingMessage,
  response: ServerResponse,
  vite?: ViteDevServer,
): Effect.Effect<void, PlaygroundServerError> => {
  if (vite !== undefined) {
    return serveWithVite(request, response, vite);
  }

  return loadIndexHtml().pipe(
    Effect.flatMap((html) => sendHtml(response, html)),
  );
};

const serveWithVite = (
  request: IncomingMessage,
  response: ServerResponse,
  vite: ViteDevServer,
): Effect.Effect<void, PlaygroundServerError> =>
  Effect.callback<void, PlaygroundServerError>((resume) => {
    vite.middlewares(request, response, (cause?: unknown) => {
      if (cause !== undefined) {
        resume(
          Effect.fail(
            new PlaygroundServerError({
              message: "Vite failed to serve playground client.",
              cause,
            }),
          ),
        );
        return;
      }

      if (!response.writableEnded) {
        resume(sendJson(response, 404, { error: "Not found" }));
        return;
      }

      resume(Effect.void);
    });
  });

const loadIndexHtml = (): Effect.Effect<string, PlaygroundServerError> =>
  Effect.tryPromise({
    try: () => readFile(resolve(getPlaygroundRoot(), "index.html"), "utf8"),
    catch: (cause) =>
      new PlaygroundServerError({
        message: "Unable to read playground index.html.",
        cause,
      }),
  });

const getPlaygroundRoot = (): string =>
  resolve(dirname(fileURLToPath(import.meta.url)), "..");

const listen = (
  server: ReturnType<typeof createServer>,
  requestedPort: number,
): Effect.Effect<AddressInfo, PlaygroundServerError> =>
  listenOnPort(server, requestedPort).pipe(
    Effect.catch((cause) => {
      if (requestedPort !== 0 && isAddressInUse(cause.cause)) {
        return listenOnPort(server, 0);
      }

      return Effect.fail(cause);
    }),
  );

const listenOnPort = (
  server: ReturnType<typeof createServer>,
  port: number,
): Effect.Effect<AddressInfo, PlaygroundServerError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<AddressInfo>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          const address = server.address();

          if (address === null || typeof address === "string") {
            reject(
              new PlaygroundServerError({
                message: "Playground server did not expose a TCP address.",
              }),
            );
            return;
          }

          resolve(address);
        });
      }),
    catch: (cause) =>
      new PlaygroundServerError({
        message: "Unable to start playground server.",
        cause,
      }),
  });

const isAddressInUse = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === "EADDRINUSE";

const closeServer = (
  server: ReturnType<typeof createServer>,
): Effect.Effect<void> =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );

const waitForProcessClose: Effect.Effect<void> = Effect.callback<void>(
  (resume) => {
    const done = (): void => {
      process.stdin.off("close", done);
      process.stdin.off("end", done);
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resume(Effect.void);
    };

    process.stdin.once("close", done);
    process.stdin.once("end", done);
    process.once("SIGINT", done);
    process.once("SIGTERM", done);

    return Effect.sync(() => {
      process.stdin.off("close", done);
      process.stdin.off("end", done);
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
    });
  },
);

const readJson = (
  request: IncomingMessage,
): Effect.Effect<unknown, PlaygroundServerError> =>
  Effect.tryPromise({
    try: async () => {
      const chunks: Array<Buffer> = [];

      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }

      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    },
    catch: (cause) =>
      new PlaygroundServerError({
        message: "Failed to read JSON request body.",
        cause,
      }),
  });

const sendHtml = (
  response: ServerResponse,
  html: string,
): Effect.Effect<void, PlaygroundServerError> =>
  sendResponse(response, 200, html, "text/html; charset=utf-8");

const sendJson = (
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): Effect.Effect<void, PlaygroundServerError> =>
  sendResponse(
    response,
    statusCode,
    JSON.stringify(body),
    "application/json; charset=utf-8",
  );

const sendEmpty = (
  response: ServerResponse,
  statusCode: number,
): Effect.Effect<void, PlaygroundServerError> =>
  sendResponse(response, statusCode, "", "text/plain; charset=utf-8");

const sendResponse = (
  response: ServerResponse,
  statusCode: number,
  payload: string,
  contentType: string,
): Effect.Effect<void, PlaygroundServerError> =>
  Effect.try({
    try: () => {
      response.writeHead(statusCode, {
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "content-length": Buffer.byteLength(payload),
        "content-type": contentType,
      });
      response.end(payload);
    },
    catch: (cause) =>
      new PlaygroundServerError({
        message: "Failed to write playground response.",
        cause,
      }),
  });

const toErrorBody = (
  cause: unknown,
): {
  readonly error: string;
  readonly tag?: string;
} => {
  const tag = getErrorTag(cause);

  return tag === undefined
    ? { error: safeErrorMessage(cause) }
    : { error: safeErrorMessage(cause), tag };
};

const getErrorTag = (cause: unknown): string | undefined =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  typeof cause._tag === "string"
    ? cause._tag
    : undefined;

const safeErrorMessage = (cause: unknown): string => {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string" &&
    cause.message.length > 0
  ) {
    return cause.message;
  }

  if (
    typeof cause === "object" &&
    cause !== null &&
    "error" in cause &&
    cause.error !== undefined
  ) {
    return safeErrorMessage(cause.error);
  }

  if (
    typeof cause === "object" &&
    cause !== null &&
    "cause" in cause &&
    cause.cause !== undefined
  ) {
    return safeErrorMessage(cause.cause);
  }

  if (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    typeof cause._tag === "string"
  ) {
    return cause._tag;
  }

  return String(cause);
};

const main = async (): Promise<void> => {
  await Effect.runPromise(
    runPlayground(process.argv.slice(2), process.env, process.cwd()),
  );
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((cause: unknown) => {
    process.stderr.write(`${safeErrorMessage(cause)}\n`);
    process.exitCode = 1;
  });
}
