/**
 * Production-shaped integration test for per-host actor runtime management.
 *
 * This test calls the runtime manager directly, below the daemon process, RPC,
 * and public HTTP client boundaries. Everything inside the actor boundary is
 * real: generated Effect.Service Layers, actor manager, actor ManagedRuntime,
 * file-backed state, shared HostInstanceHandler, Node stdio MCP connector, a
 * real fixture MCP child process, and the restricted Deno sandbox.
 *
 * The production keyring Layer is present but this portable integration does
 * not write OS credentials: headless Linux, macOS, and Windows CI expose
 * different interactive keyring facilities. Secret protocol semantics remain
 * covered with the shared exact-key backend contract; a real-keyring test must
 * be environment-gated rather than silently falling back to weaker storage.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodeModeExecuteRequest } from "@ptools/code-mode-api";
import { UserPtoolsConfig } from "@ptools/config/contracts";
import type {
  HostOperationDispatchInput,
  HostOperationRequest,
} from "@ptools/host-api";
import { Effect, Layer, Option, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { NodeHostActorRuntimeOptions } from "../src/hostActorDaemon/actorRuntime/contracts/nodeHostActorRuntimeOptions.js";
import { NodeDaemonHostActorRuntimeActivator } from "../src/hostActorDaemon/actorRuntime/services/nodeDaemonHostActorRuntimeActivator.js";
import { NodeHostRuntimeManager } from "../src/hostActorDaemon/actorRuntime/services/nodeHostRuntimeManager.js";

const fixtureMcpServer = fileURLToPath(
  new URL(
    "../../mcp-registry/test/fixtures/stdio-mcp-server.ts",
    import.meta.url,
  ),
);

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const hasDeno = (() => {
  try {
    execFileSync("deno", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasDeno)("Node host runtime manager integration", () => {
  it("persists config, recreates an actor, and executes through real MCP and Deno", async () => {
    const internalStateDirectory = await mkdtemp(
      join(tmpdir(), "ptools-host-actor-integration-"),
    );
    temporaryDirectories.push(internalStateDirectory);
    const options: NodeHostActorRuntimeOptions = {
      internalStateDirectory,
      keyringServiceName: `ptools-host-actor-integration-${process.pid}`,
      denoExecutable: "deno",
    };
    // The runtime manager receives operations after carrier schema decoding.
    // Decode authored fixtures during setup, not inside manager dispatch.
    const config = decodeUserConfigForTest({
      fixture: {
        command: process.execPath,
        args: ["--import", "tsx", fixtureMcpServer],
      },
    });
    const emptyConfig = decodeUserConfigForTest({});

    // First daemon-manager lifetime creates the actor and persists authored
    // config through the real Node file storage backend.
    const configured = await runWithProductionManager(
      options,
      Effect.flatMap(NodeHostRuntimeManager, (manager) =>
        manager.dispatch(
          inputFor("host-a", {
            operation: "configure",
            input: { config },
          }),
        ),
      ),
    );
    expect(configured).toMatchObject({
      operation: "configure",
      result: { ok: true, hostId: "host-a", serverCount: 1 },
    });

    // A new manager and actor runtime must reload the persisted config, connect
    // to the real stdio MCP fixture, and run generated code in real Deno. Host B
    // receives an independent empty config in the same daemon manager.
    const result = await runWithProductionManager(
      options,
      Effect.gen(function* () {
        const manager = yield* NodeHostRuntimeManager;
        const executed = yield* manager.dispatch(
          inputFor("host-a", {
            operation: "code_mode",
            input: {
              operation: "execute",
              input: CodeModeExecuteRequest.make({
                code: `async () => fixture.echo({ text: "hello from node actor" })`,
                timeoutMs: Option.none(),
              }),
            },
          }),
        );
        yield* manager.dispatch(
          inputFor("host-b", {
            operation: "configure",
            input: { config: emptyConfig },
          }),
        );
        const hostB = yield* manager.dispatch(
          inputFor("host-b", {
            operation: "code_mode",
            input: { operation: "search_providers" },
          }),
        );
        return { executed, hostB };
      }),
    );

    expect(result.executed).toEqual({
      operation: "code_mode",
      result: {
        ok: true,
        response: {
          operation: "execute",
          output: {
            value: { text: "hello from node actor" },
            logs: [],
            warnings: [],
          },
        },
      },
    });
    expect(result.hostB).toMatchObject({
      operation: "code_mode",
      result: {
        ok: true,
        response: {
          operation: "search_providers",
          output: { providers: [], diagnostics: [] },
        },
      },
    });
  }, 30_000);
});

/** Construct the decoded config value that the HTTP boundary normally supplies. */
const decodeUserConfigForTest = (mcpServers: Record<string, unknown>) =>
  Schema.decodeUnknownSync(UserPtoolsConfig)({ mcpServers });

const runWithProductionManager = <A, E>(
  options: NodeHostActorRuntimeOptions,
  effect: Effect.Effect<A, E, NodeHostRuntimeManager>,
): Promise<A> => {
  const managerLayer = NodeHostRuntimeManager.Default.pipe(
    Layer.provide(NodeDaemonHostActorRuntimeActivator.Default(options)),
  );
  return Effect.runPromise(
    Effect.scoped(effect.pipe(Effect.provide(managerLayer))),
  );
};

const inputFor = (
  hostId: string,
  request: HostOperationRequest,
): HostOperationDispatchInput => ({
  hostId,
  publicOrigin: "http://127.0.0.1:43123",
  caller: Option.none(),
  request,
});
