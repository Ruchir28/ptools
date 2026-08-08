/**
 * End-to-end coverage: ordinary clients → deployment control plane → actor daemon.
 *
 * Background — an explicit foreground command owns one named deployment and
 * fixed listener. Ordinary clients share it and close only client resources.
 *
 * What this proves:
 *   1. Explicit configure followed by Code Mode reaches a real daemon actor.
 *   2. Independent named and generic clients share one explicitly running
 *      control plane without influencing its process lifetime.
 *
 * HTTP, daemon startup/RPC, MCP stdio, and Deno are real.
 */
import {
  execFileSync,
  spawn,
  type ChildProcess,
} from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodeModeSearchRequest } from "@ptools/code-mode-api";
import { UserPtoolsConfig } from "@ptools/config/contracts";
import { Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { createHostHttpClient } from "@ptools/host-api/http";
import { createNodeLocalDeployment } from "../src/localDeployments/nodeLocalDeploymentCatalog.js";
import { nodeControlPlanePublicOrigin } from "../src/localDeployments/contracts/nodeLocalDeploymentDescriptor.js";
import {
  connectLocalNodeHost,
} from "../src/services/nodeLocalDeploymentRunner.js";
import { NODE_INTERNAL_ACCESS_TOKEN } from "../src/options.js";

const fixturePath = fileURLToPath(
  new URL(
    "../../mcp-registry/test/fixtures/stdio-mcp-server.ts",
    import.meta.url,
  ),
);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const controlPlaneEntrypoint = join(
  packageRoot,
  "src",
  "hostControlPlaneDaemon",
  "daemonProcess",
  "nodeHostControlPlaneDaemonEntrypoint.ts",
);
const tsxImport = fileURLToPath(import.meta.resolve("tsx"));

const hasDeno = (() => {
  try {
    execFileSync("deno", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasDeno)("public Host API to daemon integration", () => {
  it("shares one explicitly configured actor across independent clients", async () => {
    const home = await mkdtemp(join(tmpdir(), "ptools-http-daemon-"));
    const previousHome = process.env.PTOOLS_HOME;
    process.env.PTOOLS_HOME = home;
    const config = await Schema.decodeUnknownPromise(UserPtoolsConfig)({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [fileURLToPath(import.meta.resolve("tsx/cli")), fixturePath],
        },
      },
    });
    const port = await freePort();
    const descriptor = await Effect.runPromise(
      createNodeLocalDeployment({
        name: "integration",
        port,
      }),
    );
    let first: Awaited<ReturnType<typeof connectLocalNodeHost>> | undefined;
    let second: Awaited<ReturnType<typeof connectLocalNodeHost>> | undefined;
    const server = spawn(
      process.execPath,
      [
        "--import",
        tsxImport,
        controlPlaneEntrypoint,
        "--deployment-name",
        descriptor.name,
      ],
      {
        cwd: packageRoot,
        env: { ...process.env, PTOOLS_HOME: home },
        stdio: "ignore",
      },
    );

    try {
      await waitUntilListening(descriptor.controlPlanePort);
      await waitUntilHttpRouter(descriptor.controlPlanePort);
      first = await connectLocalNodeHost({
        deploymentName: descriptor.name,
        hostId: "shared-actor",
      });
      second = await connectLocalNodeHost({
        deploymentName: descriptor.name,
        hostId: "shared-actor",
      });
      await expect(
        first.call({ operation: "configure", input: { config } }),
      ).resolves.toMatchObject({ result: { ok: true } });
      await expect(first.codeMode.call(searchRequest())).resolves.toMatchObject(
        {
          output: { actions: [{ toolId: "fixture.echo" }] },
        },
      );

      await first.close();
      await second.close();
      // The foreground server remains available because client close has no
      // server-side lease, heartbeat, or shutdown meaning.
      const later = await createHostHttpClient({
        baseUrl: nodeControlPlanePublicOrigin(descriptor.controlPlanePort),
        hostId: "shared-actor",
        accessToken: NODE_INTERNAL_ACCESS_TOKEN,
      });
      try {
        await expect(
          later.codeMode.call(searchRequest()),
        ).resolves.toMatchObject({
          output: { actions: [{ toolId: "fixture.echo" }] },
        });
      } finally {
        await later.close();
      }
    } finally {
      await first?.close();
      await second?.close();
      // This test owns real Deno/MCP descendants and is about request routing,
      // not graceful signal cleanup. Force-terminate the isolated foreground
      // process so a transport keep-alive cannot extend the test lifetime.
      if (server.exitCode === null) server.kill("SIGKILL");
      await waitForExit(server, 10_000).catch(() => undefined);
      if (previousHome === undefined) delete process.env.PTOOLS_HOME;
      else process.env.PTOOLS_HOME = previousHome;
    }
  }, 30_000);
});

/** Wait until the foreground listener accepts TCP connections. */
const waitUntilListening = async (port: number): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await portIsOpen(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for foreground listener on ${port}.`);
};

const portIsOpen = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

/** Wait until the complete shared router, not only its TCP socket, responds. */
const waitUntilHttpRouter = async (port: number): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/__ptools_test_readiness_probe__`,
        { signal: AbortSignal.timeout(250) },
      );
      if (response.status === 404) return;
    } catch {
      // The listener may bind before the complete application layer is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the shared Host HTTP router.");
};

const waitForExit = (child: ChildProcess, timeoutMs: number): Promise<void> =>
  child.exitCode !== null
    ? Promise.resolve()
    : new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Timed out waiting for foreground process.")),
          timeoutMs,
        );
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });

const searchRequest = () => ({
  operation: "search" as const,
  input: CodeModeSearchRequest.make({
    query: "echo",
    provider: Option.none(),
    limit: Option.none(),
  }),
});

/** Bind port 0 briefly to learn a free loopback port, then close the listener. */
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
