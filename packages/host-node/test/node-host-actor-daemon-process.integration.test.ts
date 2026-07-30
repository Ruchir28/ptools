/**
 * Black-box tests for the executable daemon boundary. Each candidate is a real
 * child process with its own Effect runtime, kernel lock, filesystem metadata,
 * and loopback HTTP listener. Tests discover it exactly as a caller would: by
 * reading ready metadata and the private credential, then using typed RPC.
 */
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { Effect, Layer } from "effect";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  NODE_HOST_ACTOR_DAEMON_CREDENTIAL_HEADER,
  NODE_HOST_ACTOR_DAEMON_PROTOCOL_HEADER,
  NODE_HOST_ACTOR_DAEMON_PROTOCOL_VERSION,
  NodeHostActorDaemonRpcs,
} from "../src/hostActorDaemon/rpc/nodeHostActorDaemonRpcContracts.js";
import {
  NODE_HOST_ACTOR_DAEMON_CREDENTIAL_FILE,
  NODE_HOST_ACTOR_DAEMON_READY_FILE,
  type NodeHostActorDaemonReadyMetadata,
} from "../src/hostActorDaemon/ownership/nodeHostActorDaemonOwnership.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const entrypoint = join(
  packageRoot,
  "src",
  "hostActorDaemon",
  "daemonProcess",
  "nodeHostActorDaemonEntrypoint.ts",
);
const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));
const directories: Array<string> = [];
const children: Array<ChildProcess> = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGTERM");
    await waitForExit(child, 5_000).catch(() => child.kill("SIGKILL"));
  }
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Node host-actor daemon spawned process", () => {
  it("publishes a real authenticated RPC listener and cleans up on signal", async () => {
    // Flow:
    // 1. spawn the package-owned entrypoint with startup CLI arguments
    // 2. wait for atomic ready metadata and read its separate credential file
    // 3. authenticate to the real loopback listener and exercise health/leases
    // 4. signal the process and verify cleanup or crash-safe replacement
    const directory = await mkdtemp(join(tmpdir(), "ptools-daemon-process-"));
    directories.push(directory);
    const child = spawn(
      process.execPath,
      [
        tsxCli,
        entrypoint,
        "--internal-state-directory",
        directory,
        "--keyring-service-name",
        "ptools-daemon-process-test",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);

    // Ready metadata is the handoff point: its existence means the listener is
    // already bound. The credential is intentionally not embedded in that JSON.
    const ready = await waitForReady(directory, child, 10_000);
    const credential = await readFile(
      join(directory, NODE_HOST_ACTOR_DAEMON_CREDENTIAL_FILE),
      "utf8",
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* makeClient(ready.origin, credential);
          const health = yield* client.Health();
          expect(health.ownerGeneration).toBe(ready.ownerGeneration);
          const lease = yield* client.AcquireServerLease();
          expect(lease.leaseId.length).toBeGreaterThan(20);
          yield* client.ReleaseServerLease({ leaseId: lease.leaseId });
        }),
      ),
    );

    child.kill("SIGTERM");
    const exit = await waitForExit(child, 10_000);
    if (process.platform === "win32") {
      // Node force-terminates child processes on Windows, so graceful
      // finalizers cannot run. A replacement must acquire immediately and
      // clear/replace the stale generation under the kernel lock.
      const replacement = spawnDaemon(directory);
      children.push(replacement);
      const replacementReady = await waitForReady(
        directory,
        replacement,
        10_000,
      );
      expect(replacementReady.ownerGeneration).not.toBe(ready.ownerGeneration);
      replacement.kill("SIGTERM");
      await waitForExit(replacement, 10_000);
    } else {
      // Effect v4's NodeRuntime handles the signal, interrupts the main fiber
      // so scoped finalizers run, and maps an interruption-only exit to 130.
      expect(exit.code).toBe(130);
      await expect(
        access(join(directory, NODE_HOST_ACTOR_DAEMON_READY_FILE)),
      ).rejects.toThrow();
    }
  }, 20_000);

  it("gives exactly one winner to concurrent daemon startup attempts", async () => {
    // Start two independent OS processes against one namespace without ordering
    // them. The kernel lock must elect one live winner; the contender must map
    // its typed ownership failure to the documented process exit code 75.
    const directory = await mkdtemp(join(tmpdir(), "ptools-daemon-race-"));
    directories.push(directory);
    const first = spawnDaemon(directory);
    const second = spawnDaemon(directory);
    children.push(first, second);

    const ready = await waitForEitherReady(directory, [first, second], 10_000);
    expect(ready.ownerGeneration.length).toBeGreaterThan(20);

    const loser = await waitForOneExit([first, second], 10_000);
    expect(loser.exitCode).toBe(75);
    const winner = loser === first ? second : first;
    expect(winner.exitCode).toBeNull();

    winner.kill("SIGTERM");
    await waitForExit(winner, 10_000);
  }, 20_000);
});

const spawnDaemon = (directory: string): ChildProcess =>
  spawn(
    process.execPath,
    [
      tsxCli,
      entrypoint,
      "--internal-state-directory",
      directory,
      "--keyring-service-name",
      "ptools-daemon-process-test",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

/** Build the same authenticated, versioned JSON RPC transport used by callers. */
const makeClient = (origin: string, credential: string) => {
  const protocol = RpcClient.layerProtocolHttp({
    url: `${origin}/rpc`,
    transformClient: HttpClient.mapRequest((request) =>
      request.pipe(
        HttpClientRequest.setHeader(
          NODE_HOST_ACTOR_DAEMON_CREDENTIAL_HEADER,
          `Bearer ${credential}`,
        ),
        HttpClientRequest.setHeader(
          NODE_HOST_ACTOR_DAEMON_PROTOCOL_HEADER,
          NODE_HOST_ACTOR_DAEMON_PROTOCOL_VERSION,
        ),
      ),
    ),
  }).pipe(Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]));
  return RpcClient.make(NodeHostActorDaemonRpcs).pipe(Effect.provide(protocol));
};

/** Poll the atomic ready file while also failing fast if startup exits. */
const waitForReady = async (
  directory: string,
  child: ChildProcess,
  timeoutMs: number,
): Promise<NodeHostActorDaemonReadyMetadata> => {
  const path = join(directory, NODE_HOST_ACTOR_DAEMON_READY_FILE);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Daemon exited before readiness with ${child.exitCode}: ${await streamText(child.stderr)}`,
      );
    }
    try {
      return JSON.parse(
        await readFile(path, "utf8"),
      ) as NodeHostActorDaemonReadyMetadata;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(
    `Timed out waiting for daemon readiness: ${await streamText(child.stderr)}`,
  );
};

/** Observe whichever racing process wins and publishes the shared ready file. */
const waitForEitherReady = async (
  directory: string,
  candidates: ReadonlyArray<ChildProcess>,
  timeoutMs: number,
): Promise<NodeHostActorDaemonReadyMetadata> => {
  const path = join(directory, NODE_HOST_ACTOR_DAEMON_READY_FILE);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(
        await readFile(path, "utf8"),
      ) as NodeHostActorDaemonReadyMetadata;
    } catch {
      if (candidates.every((candidate) => candidate.exitCode !== null)) {
        throw new Error("Every daemon candidate exited before readiness.");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("Timed out waiting for a concurrent daemon winner.");
};

/** Return the ownership contender that exits while its peer remains alive. */
const waitForOneExit = async (
  candidates: ReadonlyArray<ChildProcess>,
  timeoutMs: number,
): Promise<ChildProcess> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exited = candidates.find((candidate) => candidate.exitCode !== null);
    if (exited !== undefined) return exited;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for a losing daemon candidate.");
};

const waitForExit = (
  child: ChildProcess,
  timeoutMs: number,
): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}> =>
  new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for daemon process exit.")),
      timeoutMs,
    );
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });

const streamText = async (
  stream: NodeJS.ReadableStream | null,
): Promise<string> => {
  if (stream === null) return "";
  const chunks: Array<Buffer> = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};
