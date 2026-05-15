import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Cause, Effect, Option, Scope } from "effect";
import {
  ExecutorProtocolError,
  ExecutorRuntimeError,
  ExecutorStartError,
  InvalidExecutorCode,
  type ExecutorError,
} from "./errors.js";
import type {
  ExecuteResult,
  ExecutorProvider,
  ExecutorProviderHandler,
  RpcCallRequest,
  RpcCallResponse,
  SandboxCompleteRequest,
  SerializedSandboxError,
} from "./types.js";

export type ProviderMap = ReadonlyMap<string, ExecutorProvider["fns"]>;

interface RunState {
  readonly token: string;
  readonly providers: ProviderMap;
  readonly complete: (result: ExecuteResult) => void;
  readonly fail: (error: ExecutorError) => void;
}

export interface RegisterRunOptions extends RunState {
  readonly runId: string;
}

export interface RegisteredRun {
  readonly runId: string;
  readonly rpcUrl: string;
  readonly unregister: () => void;
}

type RpcRoute = {
  readonly runId: string;
  readonly action: "call" | "complete";
};

export class RpcHost {
  readonly #server: ReturnType<typeof createServer>;
  readonly #baseUrl: string;
  readonly #runs = new Map<string, RunState>();

  private constructor(
    server: ReturnType<typeof createServer>,
    address: AddressInfo,
  ) {
    this.#server = server;
    this.#baseUrl = `http://127.0.0.1:${address.port}`;
  }

  static make(): Effect.Effect<RpcHost, ExecutorStartError, Scope.Scope> {
    return Effect.acquireRelease(
      Effect.gen(function* () {
        const server = createServer();

        yield* listen(server).pipe(
          Effect.catchAll((cause) =>
            closeServer(server).pipe(
              Effect.zipRight(Effect.fail(new ExecutorStartError({ cause }))),
            ),
          ),
        );

        const host = yield* Effect.try({
          try: () => new RpcHost(server, getServerAddress(server)),
          catch: (cause) => new ExecutorStartError({ cause }),
        }).pipe(
          Effect.catchAll((error) =>
            closeServer(server).pipe(Effect.zipRight(Effect.fail(error))),
          ),
        );

        server.on("request", (request, response) => {
          void Effect.runPromise(host.handleRequest(request, response));
        });

        return host;
      }),
      (host) => host.close(),
    );
  }

  registerRun(options: RegisterRunOptions): RegisteredRun {
    if (this.#runs.has(options.runId)) {
      throw new ExecutorProtocolError({
        message: `Duplicate executor run id: ${options.runId}`,
      });
    }

    this.#runs.set(options.runId, {
      token: options.token,
      providers: options.providers,
      complete: options.complete,
      fail: options.fail,
    });

    return {
      runId: options.runId,
      rpcUrl: `${this.#baseUrl}/runs/${options.runId}`,
      unregister: () => this.unregisterRun(options.runId),
    };
  }

  unregisterRun(runId: string): void {
    this.#runs.delete(runId);
  }

  activeRunCount(): number {
    return this.#runs.size;
  }

  close(): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#runs.clear();
    }).pipe(Effect.zipRight(closeServer(this.#server)));
  }

  private handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Effect.Effect<void> {
    let runState: RunState | undefined;

    return Effect.gen(this, function* () {
      const route = parseRpcRoute(request);

      if (route === undefined) {
        return yield* sendJson(response, 404, { error: "Not found" });
      }

      const run = this.#runs.get(route.runId);

      if (run === undefined) {
        return yield* sendJson(response, 404, {
          error: "Executor run not found",
        });
      }

      runState = run;

      if (!isAuthorized(request, run.token)) {
        return yield* sendJson(response, 401, { error: "Unauthorized" });
      }

      if (route.action === "call") {
        return yield* handleRpcCall(request, response, run.providers);
      }

      return yield* this.handleComplete(request, response, route, run);
    }).pipe(
      Effect.catchAll((cause) => {
        const error = new ExecutorProtocolError({
          message: "Executor RPC protocol failure",
          cause,
        });

        return sendJson(response, 500, { error: error.message }).pipe(
          Effect.catchAll(() => Effect.void),
          Effect.zipRight(Effect.sync(() => runState?.fail(error))),
        );
      }),
    );
  }

  private handleComplete(
    request: IncomingMessage,
    response: ServerResponse,
    route: RpcRoute,
    run: RunState,
  ): Effect.Effect<void, ExecutorProtocolError> {
    return Effect.gen(this, function* () {
      const body = (yield* readJson(request)) as SandboxCompleteRequest;

      yield* Effect.sync(() => this.unregisterRun(route.runId));

      if (body.ok) {
        yield* sendJson(response, 200, { ok: true });
        return yield* Effect.sync(() =>
          run.complete({ value: body.value, logs: body.logs }),
        );
      }

      yield* sendJson(response, 200, { ok: true });
      return yield* Effect.sync(() =>
        run.fail(toExecutorRuntimeError(body.error)),
      );
    });
  }
}

const parseRpcRoute = (
  request: IncomingMessage,
): RpcRoute | undefined => {
  if (request.method !== "POST") {
    return undefined;
  }

  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const match = /^\/runs\/([^/]+)\/(call|complete)$/.exec(url.pathname);

  if (match === null) {
    return undefined;
  }

  return {
    runId: decodeURIComponent(match[1] ?? ""),
    action: match[2] === "complete" ? "complete" : "call",
  };
};

const handleRpcCall = (
  request: IncomingMessage,
  response: ServerResponse,
  providers: ProviderMap,
): Effect.Effect<void, ExecutorProtocolError> =>
  Effect.gen(function* () {
    const body = (yield* readJson(request)) as RpcCallRequest;
    const handler = providers.get(body.provider)?.[body.tool];

    if (handler === undefined) {
      const result: RpcCallResponse = {
        ok: false,
        error: {
          name: "ProviderToolNotFound",
          message: `Provider tool not found: ${body.provider}.${body.tool}`,
          code: "ProviderToolNotFound",
        },
      };

      return yield* sendJson(response, 404, result);
    }

    return yield* runProviderHandler(handler, body.input).pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          sendJson(response, 200, {
            ok: false,
            error: serializeCause(cause, "ProviderToolError"),
          } satisfies RpcCallResponse),
        onSuccess: (value) =>
          sendJson(response, 200, {
            ok: true,
            value,
          } satisfies RpcCallResponse),
      }),
    );
  });

const runProviderHandler = (
  handler: ExecutorProviderHandler,
  input: unknown,
): Effect.Effect<unknown, unknown> => Effect.suspend(() => handler(input));

const listen = (
  server: ReturnType<typeof createServer>,
): Effect.Effect<void, unknown> =>
  Effect.tryPromise(
    () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      }),
  );

const getServerAddress = (
  server: ReturnType<typeof createServer>,
): AddressInfo => {
  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new ExecutorProtocolError({
      message: "Local sandbox RPC server did not expose a TCP address",
    });
  }

  return address;
};

const closeServer = (
  server: ReturnType<typeof createServer>,
): Effect.Effect<void> =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );

const isAuthorized = (
  request: IncomingMessage,
  token: string,
): boolean => request.headers.authorization === `Bearer ${token}`;

const readJson = (
  request: IncomingMessage,
): Effect.Effect<unknown, ExecutorProtocolError> =>
  Effect.tryPromise({
    try: async () => {
      const chunks: Array<Buffer> = [];

      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }

      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    },
    catch: (cause) =>
      new ExecutorProtocolError({
        message: "Failed to read executor RPC request JSON",
        cause,
      }),
  });

const sendJson = (
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): Effect.Effect<void, ExecutorProtocolError> =>
  Effect.try({
    try: () => {
      if (response.headersSent) {
        return;
      }

      const payload = JSON.stringify(body);
      response.writeHead(statusCode, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      });
      response.end(payload);
    },
    catch: (cause) =>
      new ExecutorProtocolError({
        message: "Failed to write executor RPC response",
        cause,
      }),
  });

const toExecutorRuntimeError = (
  error: SerializedSandboxError,
): InvalidExecutorCode | ExecutorRuntimeError =>
  error.code === "InvalidExecutorCode"
    ? new InvalidExecutorCode({ error })
    : new ExecutorRuntimeError({ error });

const serializeCause = (
  cause: Cause.Cause<unknown>,
  code?: string,
): SerializedSandboxError => {
  const failure = Option.getOrUndefined(Cause.failureOption(cause));

  return failure === undefined
    ? serializeUnknownError(new Error(Cause.pretty(cause)), code)
    : serializeUnknownError(failure, code);
};

const serializeUnknownError = (
  cause: unknown,
  code?: string,
): SerializedSandboxError => {
  if (cause instanceof Error) {
    const serialized: SerializedSandboxError = {
      name: cause.name,
      message: cause.message,
      ...(cause.stack === undefined ? {} : { stack: cause.stack }),
      ...(code === undefined ? {} : { code }),
    };

    return serialized;
  }

  return {
    message: String(cause),
    ...(code === undefined ? {} : { code }),
  };
};
