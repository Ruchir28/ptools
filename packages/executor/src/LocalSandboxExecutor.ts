import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Duration, Effect, Layer, Option, Scope } from "effect";
import { ExecutorBackend } from "./backend.js";
import {
  ExecutorProtocolError,
  ExecutorRuntimeError,
  ExecutorStartError,
  ExecutorTimeoutError,
  InvalidExecutorCode,
  type ExecutorError,
} from "./errors.js";
import { CodeExecutor, CodeExecutorLayer } from "./executor.js";
import { RpcHost } from "./RpcHost.js";
import type { SandboxCompleteRequest } from "./schema.js";
import type {
  ExecuteRequest,
  ExecuteResult,
  LocalSandboxExecutorOptions,
  PreparedExecuteRequest,
} from "./types.js";
import {
  decodeSandboxCompleteResult,
  prepareExecuteRequest,
} from "./semantic.js";

const MAX_ERROR_OUTPUT_CHARS = 4_000;

export class LocalSandboxExecutor {
  readonly #rpcHost: RpcHost;
  readonly #defaultTimeoutMs: Option.Option<number>;

  private constructor(
    rpcHost: RpcHost,
    options: LocalSandboxExecutorOptions = {},
  ) {
    this.#rpcHost = rpcHost;
    this.#defaultTimeoutMs = Option.fromNullable(options.defaultTimeoutMs);
  }

  static make(
    options?: LocalSandboxExecutorOptions,
  ): Effect.Effect<LocalSandboxExecutor, ExecutorStartError, Scope.Scope> {
    return RpcHost.make().pipe(
      Effect.map((rpcHost) => new LocalSandboxExecutor(rpcHost, options)),
    );
  }

  execute(
    request: ExecuteRequest,
  ): Effect.Effect<ExecuteResult, ExecutorError> {
    return prepareExecuteRequest(request, {
      defaultTimeoutMs: this.#defaultTimeoutMs,
    }).pipe(
      Effect.flatMap((prepared) => this.executePrepared(prepared)),
      Effect.flatMap(decodeSandboxCompleteResult),
    );
  }

  executePrepared(
    request: PreparedExecuteRequest,
  ): Effect.Effect<SandboxCompleteRequest, ExecutorError> {
    return runLocalSandboxEffect(request, this.#rpcHost).pipe(Effect.scoped);
  }
}

/**
 * Scoped `LocalSandboxExecutor` resource (child process + RPC host).
 */
export const makeLocalSandboxExecutor = (
  options?: LocalSandboxExecutorOptions,
): Effect.Effect<LocalSandboxExecutor, ExecutorStartError, Scope.Scope> =>
  LocalSandboxExecutor.make(options);

/**
 * Provides the host-neutral {@link ExecutorBackend} SPI backed by the local
 * child-process sandbox. Compose this under {@link CodeExecutorLayer} (see
 * {@link makeLocalSandboxExecutorLive}) so request preparation and result
 * decoding stay shared.
 */
export const makeLocalSandboxExecutorBackendLive = (
  options?: LocalSandboxExecutorOptions,
): Layer.Layer<ExecutorBackend, ExecutorStartError, never> =>
  Layer.scoped(
    ExecutorBackend,
    makeLocalSandboxExecutor(options).pipe(
      Effect.map((executor) => ({
        executePrepared: (request: PreparedExecuteRequest) =>
          executor.executePrepared(request),
      })),
    ),
  );

/**
 * Convenience layer that produces a fully wired {@link CodeExecutor} by
 * composing {@link CodeExecutorLayer} with the local backend. Hosts that want
 * to inject a different `ExecutorBackend` should use `CodeExecutorLayer`
 * directly with their own backend layer instead.
 */
export const makeLocalSandboxExecutorLive = (
  options?: LocalSandboxExecutorOptions,
): Layer.Layer<CodeExecutor, ExecutorStartError, never> =>
  CodeExecutorLayer({
    defaultTimeoutMs: Option.fromNullable(options?.defaultTimeoutMs),
  }).pipe(
    Layer.provide(makeLocalSandboxExecutorBackendLive()),
  );

const runLocalSandboxEffect = (
  request: PreparedExecuteRequest,
  rpcHost: RpcHost,
): Effect.Effect<SandboxCompleteRequest, ExecutorError, Scope.Scope> =>
  Effect.gen(function* () {
    const runId = randomUUID();
    const token = randomUUID();
    const payload = yield* Effect.try({
      try: () => createSandboxPayload(request),
      catch: normalizeExecutorError,
    });

    const run = createRunController();
    const registeredRun = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          rpcHost.registerRun({
            runId,
            token,
            providers: request.providers,
            complete: run.succeed,
            fail: run.fail,
          }),
        catch: normalizeExecutorError,
      }),
      (runRegistration) => Effect.sync(() => runRegistration.unregister()),
    );
    const child = yield* acquireSandboxProcess({
      payload,
      rpcUrl: registeredRun.rpcUrl,
      token,
    });
    const stderrChunks: Array<string> = [];

    yield* Effect.sync(() => {
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk.toString("utf8"));
      });

      child.once("error", (cause) => {
        run.fail(new ExecutorStartError({ cause }));
      });

      child.once("exit", (code, signal) => {
        if (!run.settled()) {
          run.fail(
            new ExecutorProtocolError({
              message: `Local sandbox exited before reporting completion (${formatExit(
                code,
                signal,
              )})${formatStderr(stderrChunks)}`,
            }),
          );
        }
      });
    });

    return yield* waitForRunResult(run, request.timeoutMs);
  }).pipe(
    Effect.mapError((error) =>
      isExecutorError(error)
        ? error
        : new ExecutorProtocolError({
            message: "Local sandbox execution failed unexpectedly",
            cause: error,
          }),
    ),
  );

const createSandboxPayload = (
  request: PreparedExecuteRequest,
): string => {
  try {
    return JSON.stringify({
      code: request.code,
      globals: request.globals,
      providers: request.providerManifests,
    });
  } catch (cause) {
    throw new ExecutorProtocolError({
      message: "Executor request contains non-serializable globals",
      cause,
    });
  }
};

const startSandboxProcess = (options: {
  readonly payload: string;
  readonly rpcUrl: string;
  readonly token: string;
}): ChildProcess => {
  const runningFromTs = import.meta.url.endsWith(".ts");
  const workerPath = fileURLToPath(
    new URL(
      runningFromTs ? "./sandbox-worker.ts" : "./sandbox-worker.js",
      import.meta.url,
    ),
  );
  const args = runningFromTs
    ? ["--experimental-strip-types", workerPath]
    : [workerPath];

  return spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: compactEnv({
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      PTOOLS_EXECUTOR_PAYLOAD: options.payload,
      PTOOLS_EXECUTOR_RPC_URL: options.rpcUrl,
      PTOOLS_EXECUTOR_RPC_TOKEN: options.token,
    }),
    stdio: ["ignore", "ignore", "pipe"],
  });
};

const acquireSandboxProcess = (options: {
  readonly payload: string;
  readonly rpcUrl: string;
  readonly token: string;
}) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => startSandboxProcess(options),
      catch: (cause) => new ExecutorStartError({ cause }),
    }),
    (child) => Effect.sync(() => stopSandboxProcess(child)),
  );

const stopSandboxProcess = (child: ChildProcess): void => {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
};

const createRunController = () => {
  let settled = false;
  let resolveResult: (result: SandboxCompleteRequest) => void;
  let rejectResult: (error: ExecutorError) => void;

  const result = new Promise<SandboxCompleteRequest>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  return {
    result,
    settled: () => settled,
    succeed: (value: SandboxCompleteRequest) => {
      if (!settled) {
        settled = true;
        resolveResult(value);
      }
    },
    fail: (error: ExecutorError) => {
      if (!settled) {
        settled = true;
        rejectResult(error);
      }
    },
  };
};

const waitForRunResult = (
  run: ReturnType<typeof createRunController>,
  timeoutMs: number,
): Effect.Effect<SandboxCompleteRequest, ExecutorError> => {
  const runResult = Effect.tryPromise({
    try: () => run.result,
    catch: normalizeExecutorError,
  });
  const timeoutError = new ExecutorTimeoutError({ timeoutMs });
  const timeout = Effect.sleep(Duration.millis(timeoutMs)).pipe(
    Effect.flatMap(() =>
      Effect.sync(() => run.fail(timeoutError)).pipe(
        Effect.zipRight(Effect.fail(timeoutError)),
      ),
    ),
  );

  return Effect.raceFirst(runResult, timeout);
};

const isExecutorError = (cause: unknown): cause is ExecutorError =>
  cause instanceof ExecutorStartError ||
  cause instanceof ExecutorProtocolError ||
  cause instanceof ExecutorTimeoutError ||
  cause instanceof InvalidExecutorCode ||
  cause instanceof ExecutorRuntimeError;

const normalizeExecutorError = (cause: unknown): ExecutorError =>
  isExecutorError(cause)
    ? cause
    : new ExecutorProtocolError({
        message: "Local sandbox execution failed unexpectedly",
        cause,
      });

const compactEnv = (
  env: Record<string, string | undefined>,
): Record<string, string> => {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }

  return result;
};

const formatExit = (
  code: number | null,
  signal: NodeJS.Signals | null,
): string => {
  if (signal !== null) {
    return `signal ${signal}`;
  }

  return `code ${code ?? "unknown"}`;
};

const formatStderr = (chunks: ReadonlyArray<string>): string => {
  const stderr = chunks.join("").trim();

  if (stderr.length === 0) {
    return "";
  }

  return `\nstderr:\n${stderr.slice(-MAX_ERROR_OUTPUT_CHARS)}`;
};
