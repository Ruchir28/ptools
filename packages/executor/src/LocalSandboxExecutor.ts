import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Duration, Effect, Layer, Scope } from "effect";
import {
  ExecutorProtocolError,
  ExecutorRuntimeError,
  ExecutorStartError,
  ExecutorTimeoutError,
  InvalidExecutorCode,
  type ExecutorError,
} from "./errors.js";
import { CodeExecutor } from "./executor.js";
import { RpcHost, type ProviderMap } from "./RpcHost.js";
import type {
  ExecuteRequest,
  ExecuteResult,
  ExecutorProvider,
  ExecutorProviders,
  LocalSandboxExecutorOptions,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ERROR_OUTPUT_CHARS = 4_000;
const VALID_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED_GLOBAL_NAMES = new Set(["console", "globalThis"]);

export class LocalSandboxExecutor {
  readonly #rpcHost: RpcHost;
  readonly #defaultTimeoutMs: number;

  private constructor(
    rpcHost: RpcHost,
    options: LocalSandboxExecutorOptions = {},
  ) {
    this.#rpcHost = rpcHost;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
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
    return runLocalSandboxEffect(
      request,
      this.#defaultTimeoutMs,
      this.#rpcHost,
    ).pipe(Effect.scoped);
  }
}

export const makeLocalSandboxExecutor = (
  options?: LocalSandboxExecutorOptions,
): Effect.Effect<LocalSandboxExecutor, ExecutorStartError, Scope.Scope> =>
  LocalSandboxExecutor.make(options);

export const makeLocalSandboxExecutorLive = (
  options?: LocalSandboxExecutorOptions,
): Layer.Layer<CodeExecutor, ExecutorStartError, never> =>
  Layer.scoped(
    CodeExecutor,
    makeLocalSandboxExecutor(options).pipe(
      Effect.map((executor) => ({
        execute: (request: ExecuteRequest) => executor.execute(request),
      })),
    ),
  );

const runLocalSandboxEffect = (
  request: ExecuteRequest,
  defaultTimeoutMs: number,
  rpcHost: RpcHost,
): Effect.Effect<ExecuteResult, ExecutorError, Scope.Scope> =>
  Effect.gen(function* () {
    const timeoutMs = request.timeoutMs ?? defaultTimeoutMs;
    const runId = randomUUID();
    const token = randomUUID();
    const providers = request.providers ?? [];
    const providerMap = yield* Effect.try({
      try: () => {
        validateGlobals(request.globals ?? {}, providers);
        return buildProviderMap(providers);
      },
      catch: normalizeExecutorError,
    });
    const payload = yield* Effect.try({
      try: () =>
        createSandboxPayload(
          request,
          providers.map((provider) => ({
            name: provider.name,
            tools: Object.keys(provider.fns),
          })),
        ),
      catch: normalizeExecutorError,
    });

    const run = createRunController();
    const registeredRun = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          rpcHost.registerRun({
            runId,
            token,
            providers: providerMap,
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

    return yield* waitForRunResult(run, timeoutMs);
  }).pipe(
    Effect.catchAll((error) =>
      Effect.fail(
        isExecutorError(error)
          ? error
          : new ExecutorProtocolError({
              message: "Local sandbox execution failed unexpectedly",
              cause: error,
            }),
      ),
    ),
  );

const createSandboxPayload = (
  request: ExecuteRequest,
  providers: ReadonlyArray<{
    readonly name: string;
    readonly tools: ReadonlyArray<string>;
  }>,
): string => {
  try {
    return JSON.stringify({
      code: request.code,
      globals: request.globals ?? {},
      providers,
    });
  } catch (cause) {
    throw new ExecutorProtocolError({
      message: "Executor request contains non-serializable globals",
      cause,
    });
  }
};

const buildProviderMap = (
  providers: ExecutorProviders,
): ProviderMap => {
  const result = new Map<string, ExecutorProvider["fns"]>();

  for (const provider of providers) {
    validateIdentifier(provider.name, "provider");

    if (result.has(provider.name)) {
      throw new ExecutorProtocolError({
        message: `Duplicate provider name: ${provider.name}`,
      });
    }

    for (const toolName of Object.keys(provider.fns)) {
      validateIdentifier(toolName, `tool in provider ${provider.name}`);
    }

    result.set(provider.name, provider.fns);
  }

  return result;
};

const validateGlobals = (
  globals: Record<string, unknown>,
  providers: ExecutorProviders,
): void => {
  const providerNames = new Set(providers.map((provider) => provider.name));

  for (const name of Object.keys(globals)) {
    validateIdentifier(name, "global");

    if (providerNames.has(name)) {
      throw new ExecutorProtocolError({
        message: `Global name collides with provider name: ${name}`,
      });
    }
  }
};

const validateIdentifier = (name: string, scope: string): void => {
  if (!VALID_IDENTIFIER.test(name) || RESERVED_GLOBAL_NAMES.has(name)) {
    throw new ExecutorProtocolError({
      message: `Invalid ${scope} identifier: ${name}`,
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
  let resolveResult: (result: ExecuteResult) => void;
  let rejectResult: (error: ExecutorError) => void;

  const result = new Promise<ExecuteResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  return {
    result,
    settled: () => settled,
    succeed: (value: ExecuteResult) => {
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
): Effect.Effect<ExecuteResult, ExecutorError> => {
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
