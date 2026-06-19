/**
 * @file Deno Sandbox Process Manager
 *
 * This file manages spawning, communicating with, and tearing down the restricted Deno
 * subprocesses used as local sandboxes. It handles process-level I/O streams and binds
 * the process lifetime to an Effect `Scope` to guarantee clean resource cleanup.
 *
 * ### Strict Sandboxing Security Flags
 *
 * To ensure absolute isolation, the Deno subprocess is spawned with the following strict
 * deny-all flags:
 * - `--deny-read`: Blocks the sandbox from reading any files on the host filesystem.
 * - `--deny-write`: Blocks the sandbox from writing any files on the host filesystem.
 * - `--deny-net`: Blocks the sandbox from initiating any network connections.
 * - `--deny-env`: Blocks the sandbox from reading host environment variables.
 * - `--deny-run`: Blocks the sandbox from spawning other subprocesses.
 * - `--deny-ffi`: Blocks the sandbox from loading foreign function interfaces (native binary code).
 * - `--deny-sys`: Blocks the sandbox from accessing system APIs (e.g., CPU, memory, OS info).
 * - `--deny-import`: Blocks the sandbox from dynamically importing external URL modules.
 *
 * ### Resource Lifecycle & Scope Binding
 *
 * The Deno process is managed as a scoped resource using `Effect.acquireRelease`. When the
 * scope closes (either due to successful completion, an error, or a timeout), the host
 * automatically initiates a shutdown sequence:
 * 1. Closes the sandbox's `stdin` stream to signal EOF.
 * 2. Sends `SIGTERM` to the process (or process group on Unix).
 * 3. Waits up to 250ms for a graceful exit.
 * 4. Forcefully terminates the process with `SIGKILL` if it fails to exit, preventing
 *    zombie processes or hung executions.
 */

import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type {
  HostToSandboxMessage,
  SandboxToHostMessage,
} from "@ptools/executor";
import { ExecutorProtocolError, ExecutorStartError } from "@ptools/executor";
import { Chunk, Effect, Option, Scope, Stream } from "effect";
import {
  decodeSandboxMessage,
  encodeHostMessage,
  MAX_SANDBOX_FRAME_BYTES,
} from "./sandboxProtocol.js";

const execFilePromise = promisify(execFile);
const MAX_STDERR_CHARS = 4_000;

/**
 * Internal configuration resolved from the public options.
 */
export interface DenoSandboxRuntimeConfig {
  readonly denoExecutable: string;
}

/**
 * Represents the final exit status of the sandbox subprocess.
 */
export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}

/**
 * A scoped handle to a spawned, restricted Deno sandbox process.
 */
export interface DenoSandboxProcess {
  /** The raw Node.js child process instance. */
  readonly child: ChildProcessWithoutNullStreams;

  /** An Effect that resolves to the final exit status of the process once it terminates. */
  readonly exit: Effect.Effect<ProcessExit, ExecutorProtocolError>;

  /** Writes a protocol message to the sandbox's stdin stream. */
  readonly write: (
    message: HostToSandboxMessage,
  ) => Effect.Effect<void, ExecutorProtocolError>;
}

export const resolveDenoSandboxRuntimeConfig = (
  options: {
    readonly denoExecutable?: string;
  } = {},
): Effect.Effect<DenoSandboxRuntimeConfig, ExecutorStartError> =>
  Effect.tryPromise({
    try: () => resolveDenoExecutable(options),
    catch: (cause) =>
      cause instanceof ExecutorStartError
        ? cause
        : new ExecutorStartError({
            message: "Failed to resolve the Deno sandbox runtime.",
            cause,
          }),
  }).pipe(Effect.map((denoExecutable) => ({ denoExecutable })));

interface DenoExecutableCandidate {
  readonly executable: string;
  readonly required: boolean;
  readonly source: "option" | "DENO_BIN" | "home" | "PATH";
}

/**
 * Resolve Deno without probing platform-specific package-manager locations.
 * Explicit configuration fails fast; the canonical Deno home installation is
 * tried before the normal PATH fallback.
 */
const resolveDenoExecutable = async (options: {
  readonly denoExecutable?: string;
}): Promise<string> => {
  const candidates = denoExecutableCandidates(options);

  for (const candidate of candidates) {
    try {
      const { stdout } = await execFilePromise(candidate.executable, [
        "--version",
      ]);
      const match = /^deno (\d+)\./m.exec(stdout);
      if (match === null || Number(match[1]) < 2) {
        throw new ExecutorStartError({
          message: `Unsupported Deno runtime at "${candidate.executable}". Expected Deno 2 or newer, received: ${stdout.trim()}`,
        });
      }
      return candidate.executable;
    } catch (cause) {
      if (cause instanceof ExecutorStartError) throw cause;
      if (!candidate.required) continue;
      throw new ExecutorStartError({
        message: missingDenoMessage(candidate),
        cause,
      });
    }
  }

  throw new ExecutorStartError({
    message: "Deno 2 or newer could not be resolved.",
  });
};

const denoExecutableCandidates = (options: {
  readonly denoExecutable?: string;
}): ReadonlyArray<DenoExecutableCandidate> => {
  const explicit = options.denoExecutable?.trim();
  if (explicit) {
    return [{ executable: explicit, required: true, source: "option" }];
  }

  const environment = process.env.DENO_BIN?.trim();
  if (environment) {
    return [{ executable: environment, required: true, source: "DENO_BIN" }];
  }

  const home = (process.env.HOME ?? process.env.USERPROFILE)?.trim();
  const executableName = process.platform === "win32" ? "deno.exe" : "deno";
  return [
    ...(home
      ? [
          {
            executable: join(home, ".deno", "bin", executableName),
            required: false,
            source: "home" as const,
          },
        ]
      : []),
    { executable: "deno", required: true, source: "PATH" },
  ];
};

const missingDenoMessage = (candidate: DenoExecutableCandidate): string => {
  const source =
    candidate.source === "option"
      ? "the configured denoExecutable"
      : candidate.source === "DENO_BIN"
        ? "DENO_BIN"
        : "PATH";
  return `Deno 2 or newer was not found using ${source} ("${candidate.executable}"). Install Deno, set DENO_BIN, or pass denoExecutable.`;
};

/** Spawns one restricted Deno process and binds teardown to the current scope. */
export const acquireDenoSandboxProcess = (
  config: DenoSandboxRuntimeConfig,
): Effect.Effect<DenoSandboxProcess, ExecutorStartError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: () => makeProcess(config),
      catch: (cause) =>
        new ExecutorStartError({
          message: "Failed to start the Deno sandbox process.",
          cause,
        }),
    }),
    (process) => stopProcess(process.child),
  );

export const readSandboxMessages = (
  process: DenoSandboxProcess,
): Stream.Stream<SandboxToHostMessage, ExecutorProtocolError> =>
  Stream.asyncScoped<SandboxToHostMessage, ExecutorProtocolError>((emit) => {
    let buffered = "";
    let emittedTerminal = false;

    const fail = (error: ExecutorProtocolError): void => {
      if (!emittedTerminal) {
        emittedTerminal = true;
        emit(Effect.fail(Option.some(error)));
      }
    };
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString("utf8");
      if (Buffer.byteLength(buffered) > MAX_SANDBOX_FRAME_BYTES) {
        fail(
          new ExecutorProtocolError({
            message: "Sandbox protocol frame exceeds size limit",
          }),
        );
        return;
      }
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.length === 0) continue;
        emit(
          decodeSandboxMessage(line).pipe(
            Effect.map(Chunk.of),
            Effect.mapError(Option.some),
          ),
        );
      }
    };
    const onError = (cause: Error): void =>
      fail(
        new ExecutorProtocolError({
          message: "Failed reading sandbox stdout",
          cause,
        }),
      );
    const onEnd = (): void => {
      if (!emittedTerminal) {
        if (buffered.trim().length > 0) {
          fail(
            new ExecutorProtocolError({
              message: "Sandbox stdout closed with an incomplete frame",
            }),
          );
        } else {
          emittedTerminal = true;
          emit(Effect.fail(Option.none()));
        }
      }
    };

    process.child.stdout.on("data", onData);
    process.child.stdout.once("error", onError);
    process.child.stdout.once("end", onEnd);
    return Effect.addFinalizer(() =>
      Effect.sync(() => {
        process.child.stdout.off("data", onData);
        process.child.stdout.off("error", onError);
        process.child.stdout.off("end", onEnd);
      }),
    );
  }, "unbounded");

const makeProcess = (config: DenoSandboxRuntimeConfig): DenoSandboxProcess => {
  const workerPath = resolveWorkerPath();
  const child = spawn(
    config.denoExecutable,
    [
      "run",
      "--quiet",
      "--no-prompt",
      "--no-check",
      "--deny-read",
      "--deny-write",
      "--deny-net",
      "--deny-env",
      "--deny-run",
      "--deny-ffi",
      "--deny-sys",
      "--deny-import",
      workerPath,
    ],
    { stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" },
  );

  const stderrChunks: Array<string> = [];
  child.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk.toString("utf8"));
    const joined = stderrChunks.join("");
    if (joined.length > MAX_STDERR_CHARS)
      stderrChunks.splice(
        0,
        stderrChunks.length,
        joined.slice(-MAX_STDERR_CHARS),
      );
  });

  const exitPromise = new Promise<ProcessExit>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      resolve({ code, signal, stderr: stderrChunks.join("").trim() }),
    );
  });
  let writeQueue = Promise.resolve();

  return {
    child,
    exit: Effect.tryPromise({
      try: () => exitPromise,
      catch: (cause) =>
        new ExecutorProtocolError({
          message: "Deno sandbox process failed",
          cause,
        }),
    }),
    write: (message) =>
      encodeHostMessage(message).pipe(
        Effect.flatMap((frame) =>
          Effect.tryPromise({
            try: () => {
              writeQueue = writeQueue.then(
                () =>
                  new Promise<void>((resolve, reject) => {
                    child.stdin.write(frame, (error) =>
                      error ? reject(error) : resolve(),
                    );
                  }),
              );
              return writeQueue;
            },
            catch: (cause) =>
              new ExecutorProtocolError({
                message: "Failed writing sandbox protocol frame",
                cause,
              }),
          }),
        ),
      ),
  };
};

const resolveWorkerPath = (): string =>
  fileURLToPath(import.meta.resolve("#sandbox-worker"));

const stopProcess = (
  child: ChildProcessWithoutNullStreams,
): Effect.Effect<void> =>
  Effect.promise(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    const pid = child.pid;
    const kill = (signal: NodeJS.Signals): void => {
      if (pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-pid, signal);
      } catch {}
    };
    kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 250)),
    ]);
    if (child.exitCode === null && child.signalCode === null) kill("SIGKILL");
  });
