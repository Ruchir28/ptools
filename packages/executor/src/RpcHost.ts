/**
 * Node/local callback transport for sandbox provider calls.
 *
 * This is transport mechanics, not executor semantics. It decodes the local
 * HTTP payloads used by the current child-process backend, delegates provider
 * dispatch to `invokeProviderCall`, and forwards sandbox completion envelopes
 * back to the backend. The shared executor contract is the DTOs in
 * `schema.ts`; this file is just one backend's way of carrying them.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Effect, Runtime, Schema, Scope } from "effect";
import {
  ExecutorProtocolError,
  ExecutorStartError,
  type ExecutorError,
} from "./errors.js";
import type {
  ExecutorProvider,
  ExecutorProviders,
} from "./types.js";
import {
  SandboxCompleteRequest,
  SandboxProviderCall,
  type SandboxProviderCallResult,
} from "./schema.js";
import { invokeProviderCall } from "./semantic.js";

export type ProviderMap = ReadonlyMap<string, ExecutorProvider["fns"]>;
export const providersToMap = (
  providers: ExecutorProviders,
): ProviderMap =>
  new Map(providers.map((provider) => [provider.name, provider.fns]));

interface RunState {
  readonly token: string;
  readonly providers: ExecutorProviders;
  readonly complete: (result: SandboxCompleteRequest) => void;
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

        const runPromise = Runtime.runPromise(yield* Effect.runtime<never>());

        server.on("request", (request, response) => {
          void runPromise(host.handleRequest(request, response));
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
      const body = yield* readJson(request).pipe(
        Effect.flatMap(
          Schema.decodeUnknown(SandboxCompleteRequest),
        ),
        Effect.mapError(
          (cause) =>
            new ExecutorProtocolError({
              message: "Invalid executor sandbox completion payload",
              cause,
            }),
        ),
      );

      yield* Effect.sync(() => this.unregisterRun(route.runId));

      yield* sendJson(response, 200, { ok: true });
      return yield* Effect.sync(() => run.complete(body));
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
  providers: ExecutorProviders,
): Effect.Effect<void, ExecutorProtocolError> =>
  Effect.gen(function* () {
    const body = yield* readJson(request).pipe(
      Effect.flatMap(Schema.decodeUnknown(SandboxProviderCall)),
      Effect.mapError(
        (cause) =>
          new ExecutorProtocolError({
            message: "Invalid executor provider call payload",
            cause,
          }),
      ),
    );

    const result = yield* invokeProviderCall(providers, body);
    const statusCode = isProviderNotFound(result) ? 404 : 200;

    return yield* sendJson(response, statusCode, result);
  });

const isProviderNotFound = (result: SandboxProviderCallResult): boolean =>
  !result.ok && result.error.code === "ProviderToolNotFound";

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
