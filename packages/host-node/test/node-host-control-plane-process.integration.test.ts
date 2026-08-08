/**
 * Black-box coverage for the minimal foreground Node control plane.
 *
 * Mental model:
 *   A catalog descriptor maps a deployment name to one fixed loopback port and
 *   state directory. An explicitly started foreground process claims the
 *   control-plane native lock, opens that port, and privately acquires the actor
 *   daemon connection. Clients only resolve the descriptor and use HTTP; they
 *   never receive authority to start, stop, or replace the foreground owner.
 *
 * What this proves:
 *   1. Named clients neither start the listener nor stop it when they close.
 *   2. Concurrent foreground candidates for one descriptor elect exactly one
 *      native-lock owner without publishing public readiness metadata.
 *   3. Normal interruption and forced death release kernel-owned resources so
 *      a replacement process can claim the same deployment.
 *   4. A fixed-port conflict fails startup without silently selecting another
 *      port or rewriting persisted infrastructure.
 *
 * Boundaries:
 *   The control plane and actor daemon are real child processes. Native locks,
 *   actor RPC, catalog files, OS signals, and loopback TCP are also real. The
 *   tests use polling helpers for observation, but no lifecycle service, lock,
 *   transport, or readiness response is mocked or faked.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NODE_HOST_ACTOR_DAEMON_READY_FILE } from "../src/hostActorDaemon/ownership/nodeHostActorDaemonOwnership.js";
import {
  NODE_HOST_CONTROL_PLANE_LOCK_FILE,
} from "../src/hostControlPlaneDaemon/ownership/nodeHostControlPlaneOwnership.js";
import {
  createNodeLocalDeployment,
  resolveNodeLocalDeployment,
} from "../src/localDeployments/nodeLocalDeploymentCatalog.js";
import { connectLocalNodeHost } from "../src/services/nodeLocalDeploymentRunner.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const entrypoint = join(
  packageRoot,
  "src",
  "hostControlPlaneDaemon",
  "daemonProcess",
  "nodeHostControlPlaneDaemonEntrypoint.ts",
);
const tsxImport = fileURLToPath(import.meta.resolve("tsx"));

let previousHome: string | undefined;
let home: string;
const children: Array<ChildProcess> = [];
const servers: Array<Server> = [];

beforeEach(async () => {
  // PTOOLS_HOME is process-global, so every test gets an isolated catalog and
  // the suite explicitly disables concurrency to prevent cross-test rewrites.
  previousHome = process.env.PTOOLS_HOME;
  home = await mkdtemp(join(tmpdir(), "ptools-control-plane-process-"));
  process.env.PTOOLS_HOME = home;
});

afterEach(async () => {
  // Cleanup owns every resource that a failed assertion may leave behind; this
  // prevents a real process, listener, or actor daemon from poisoning later
  // tests.
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGTERM");
    await waitForExit(child, 5_000).catch(() => child.kill("SIGKILL"));
  }
  await stopActorDaemonIfPresent(home);
  await rm(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.PTOOLS_HOME;
  else process.env.PTOOLS_HOME = previousHome;
});

describe("minimal foreground Node control plane", { concurrent: false }, () => {
  /**
   * A client may discover and use an already-running deployment, but lifecycle
   * authority remains with the explicitly launched foreground process.
   */
  it("connects by descriptor URL without starting or stopping the server", async () => {
    const descriptor = await Effect.runPromise(
      createNodeLocalDeployment({ name: "connect-only", port: await freePort() }),
    );

    // Client construction performs no network preflight and cannot start the
    // configured listener. Its first Host operation would surface transport
    // failure.
    const beforeStart = await connectLocalNodeHost({
      deploymentName: descriptor.name,
      hostId: "main",
    });
    expect(await portIsOpen(descriptor.controlPlanePort)).toBe(false);
    await beforeStart.close();

    // Explicit process startup—not client construction—crosses the lifecycle
    // boundary and causes both the public listener and private actor lease to
    // exist.
    const child = spawnControlPlane(descriptor.name);
    children.push(child);
    await waitForPort(descriptor.controlPlanePort, 10_000);
    const actorReady = await waitForActorReady(
      descriptor.stateDirectory,
      10_000,
    );
    expect(actorReady.ownerGeneration.length).toBeGreaterThan(20);

    const first = await connectLocalNodeHost({
      deploymentName: descriptor.name,
      hostId: "one",
    });
    const second = await connectLocalNodeHost({
      deploymentName: descriptor.name,
      hostId: "two",
    });
    await first.close();
    await second.close();
    // Client handles own only their HTTP resources. Closing every client must
    // not close the independently owned foreground listener.
    expect(await portIsOpen(descriptor.controlPlanePort)).toBe(true);

    // The supervisor-style signal closes the process scope, which in turn must
    // release the listener and its private actor-daemon connection.
    child.kill("SIGTERM");
    await waitForExit(child, 10_000);
    await waitForPortClosed(descriptor.controlPlanePort, 10_000);
  }, 20_000);

  /**
   * Two foreground candidates for one deployment must be serialized by the
   * native lock, without recreating public readiness metadata as an authority.
   */
  it("elects one owner without publishing readiness metadata", async () => {
    const descriptor = await Effect.runPromise(
      createNodeLocalDeployment({ name: "owner-race", port: await freePort() }),
    );

    // Both independent OS processes target the same persistent lock file. One
    // must retain the native lock while the rejected contender exits.
    const first = spawnControlPlane(descriptor.name);
    const second = spawnControlPlane(descriptor.name);
    children.push(first, second);
    await waitForPort(descriptor.controlPlanePort, 10_000);
    const loser = await waitForOneExit([first, second], 10_000);
    const winner = loser === first ? second : first;
    expect(winner.exitCode).toBeNull();
    // A reachable port identifies no owner to clients. In particular, startup
    // must not revive the removed public readiness/administration protocol.
    await expect(
      access(join(descriptor.stateDirectory, "control-plane.ready.json")),
    ).rejects.toThrow();

    winner.kill("SIGTERM");
    await waitForExit(winner, 10_000);
    await waitForPortClosed(descriptor.controlPlanePort, 10_000);
    // The lock target intentionally persists across runs; closing its file
    // descriptor releases ownership without using file deletion as authority.
    expect(
      await access(
        join(descriptor.stateDirectory, NODE_HOST_CONTROL_PLANE_LOCK_FILE),
      ).then(
        () => true,
        () => false,
      ),
    ).toBe(true);
  }, 20_000);

  /**
   * Even when SIGKILL prevents application cleanup, the operating system must
   * release the dead process's lock and port so a replacement can start.
   */
  it("releases ownership after forced process death", async () => {
    const descriptor = await Effect.runPromise(
      createNodeLocalDeployment({ name: "crash", port: await freePort() }),
    );
    const first = spawnControlPlane(descriptor.name);
    children.push(first);
    await waitForPort(descriptor.controlPlanePort, 10_000);
    // SIGKILL skips application finalizers. Successful replacement therefore
    // proves ownership is tied to the kernel-held descriptor, not cleanup code.
    first.kill("SIGKILL");
    await waitForExit(first, 10_000);
    await waitForPortClosed(descriptor.controlPlanePort, 10_000);

    const replacement = spawnControlPlane(descriptor.name);
    children.push(replacement);
    await waitForPort(descriptor.controlPlanePort, 10_000);
    replacement.kill("SIGTERM");
    await waitForExit(replacement, 10_000);
  }, 20_000);

  /**
   * A catalog port is fixed infrastructure: bind failure must be visible rather
   * than silently moving the deployment to a different persisted endpoint.
   */
  it("fails on an occupied fixed port without rewriting the descriptor", async () => {
    const port = await freePort();
    // Hold the catalog's exact configured port with a real TCP listener so
    // startup reaches the same bind failure it would encounter in production.
    const blocker = createServer();
    await listen(blocker, port);
    servers.push(blocker);
    const descriptor = await Effect.runPromise(
      createNodeLocalDeployment({ name: "occupied", port }),
    );

    const child = spawnControlPlane(descriptor.name);
    children.push(child);
    await waitForExit(child, 10_000);
    expect(child.exitCode).not.toBe(0);
    // Failure must not mutate infrastructure to make the next attempt appear
    // successful on a different endpoint.
    expect(
      (await Effect.runPromise(resolveNodeLocalDeployment(descriptor.name)))
        .controlPlanePort,
    ).toBe(port);
  }, 15_000);
});

/**
 * Spawns the TypeScript entrypoint without an intermediate shell so test
 * signals reach the process that owns the native lock and listener.
 */
const spawnControlPlane = (deploymentName: string): ChildProcess =>
  spawn(
    process.execPath,
    [
      "--import",
      tsxImport,
      entrypoint,
      "--deployment-name",
      deploymentName,
    ],
    {
      cwd: packageRoot,
      env: { ...process.env, PTOOLS_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

/**
 * Reserves an ephemeral loopback port only long enough to discover its number.
 */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a loopback test port."));
        return;
      }
      server.close((error) =>
        error === undefined ? resolve(address.port) : reject(error),
      );
    });
  });

/** Starts the real blocker used to exercise fixed-port startup failure. */
const listen = (server: Server, port: number): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

/** Uses a real TCP connection rather than daemon metadata to observe a listener. */
const portIsOpen = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

/** Polls the public TCP boundary until asynchronous process startup completes. */
const waitForPort = async (port: number, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portIsOpen(port)) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for listener on ${port}.`);
};

/**
 * Waits for private actor-daemon metadata, which is valid host-side discovery
 * state and must not be confused with forbidden public control-plane readiness.
 */
const waitForActorReady = async (
  stateDirectory: string,
  timeoutMs: number,
): Promise<{ readonly ownerGeneration: string }> => {
  const path = join(stateDirectory, NODE_HOST_ACTOR_DAEMON_READY_FILE);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as {
        readonly ownerGeneration: string;
      };
    } catch {
      await delay(25);
    }
  }
  throw new Error("Timed out waiting for private actor-daemon readiness.");
};

/** Confirms process shutdown has released the public listener. */
const waitForPortClosed = async (port: number, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portIsOpen(port))) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for listener ${port} to close.`);
};

/** Waits for a child lifecycle boundary while bounding hung-test cleanup. */
const waitForExit = (child: ChildProcess, timeoutMs: number): Promise<void> =>
  child.exitCode !== null
    ? Promise.resolve()
    : new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Timed out waiting for child exit.")),
          timeoutMs,
        );
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });

/** Identifies the native-lock contender rejected during a two-process race. */
const waitForOneExit = async (
  candidates: ReadonlyArray<ChildProcess>,
  timeoutMs: number,
): Promise<ChildProcess> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exited = candidates.find((child) => child.exitCode !== null);
    if (exited !== undefined) return exited;
    await delay(25);
  }
  throw new Error("Timed out waiting for ownership contender to exit.");
};

/**
 * Stops a private actor daemon that may outlive a control-plane failure before
 * normal scope cleanup, using only test-owned state beneath the isolated home.
 */
const stopActorDaemonIfPresent = async (root: string) => {
  const descriptorsRoot = join(root, "node-deployments");
  try {
    const { readdir } = await import("node:fs/promises");
    for (const name of await readdir(descriptorsRoot)) {
      try {
        const descriptor = JSON.parse(
          await readFile(join(descriptorsRoot, name, "deployment.json"), "utf8"),
        ) as { stateDirectory: string };
        const ready = JSON.parse(
          await readFile(
            join(descriptor.stateDirectory, NODE_HOST_ACTOR_DAEMON_READY_FILE),
            "utf8",
          ),
        ) as { pid: number };
        process.kill(ready.pid, "SIGTERM");
      } catch {
        // Stopped or never-started deployments have no actor ready metadata.
      }
    }
  } catch {
    // The test may fail before creating the catalog directory.
  }
};

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
