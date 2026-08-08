/**
 * Integration coverage for every non-Code-Mode route across both Node
 * transports.
 *
 * Background — there are two transport boundaries to preserve:
 *   A public caller first reaches the shared Host HttpApi on the Node listener.
 *   The HTTP adapter normalizes hostId, publicOrigin, verified caller, and route
 *   payload into one HostOperationDispatchInput. Node discovery then forwards
 *   that complete value over authenticated private RPC to the daemon actor.
 *   OAuth callbacks use the same path except they intentionally carry no
 *   verified API caller and return a browser response instead of JSON.
 *
 * What this proves:
 *   1. Configure, secret replacement, auth status, and auth start traverse the
 *      real public HTTP listener, shared handlers, daemon discovery, lease, and
 *      private RPC connection.
 *   2. OAuth callback GET and POST traverse that same daemon seam, preserve the
 *      provider/method/URL/body carrier facts, and project the actor's browser
 *      response back onto HTTP.
 *   3. Credentialed routes carry a normalized caller while browser callbacks
 *      carry Option.none; every route preserves hostId and publicOrigin.
 *
 * The HTTP servers, middleware, discovery, lease manager, serialization, and
 * loopback RPC transport are real. Only NodeHostRuntimeManager is a recording
 * fake: returning operation-matched responses avoids Deno, keyring, MCP network,
 * and browser OAuth side effects while keeping both transport seams observable.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  HostHttpClient,
  HostHttpClientFetchLive,
} from "@ptools/host-api/effect";
import type {
  HostOperationDispatchInput,
  HostOperationResponse,
} from "@ptools/host-api";
import { Context, Effect, Layer, Option } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { NodeHostControlPlaneHttpLive } from "../src/hostControlPlaneDaemon/http/nodeHostControlPlaneHttp.js";
import {
  NodeLocalDeploymentDescriptor,
  NodeControlPlanePort,
  NodeDeploymentStateDirectory,
} from "../src/localDeployments/contracts/nodeLocalDeploymentDescriptor.js";
import { NodeDeploymentName } from "../src/localDeployments/contracts/nodeDeploymentName.js";
import { NODE_INTERNAL_ACCESS_TOKEN } from "../src/options.js";
import { NodeHostRuntimeManager } from "../src/hostActorDaemon/actorRuntime/services/nodeHostRuntimeManager.js";
import {
  makeNodeHostActorDaemonLeaseManager,
  NodeHostActorDaemonLeaseManager,
} from "../src/hostActorDaemon/leases/services/nodeHostActorDaemonLeaseManager.js";
import {
  acquireNodeHostActorDaemonOwnership,
  publishNodeHostActorDaemonCredential,
} from "../src/hostActorDaemon/ownership/nodeHostActorDaemonOwnership.js";
import { NODE_HOST_ACTOR_DAEMON_PROTOCOL_VERSION } from "../src/hostActorDaemon/rpc/nodeHostActorDaemonRpcContracts.js";
import { startNodeHostActorDaemonRpcServer } from "../src/hostActorDaemon/rpc/nodeHostActorDaemonRpcServer.js";

it("forwards config, secrets, auth, and callback routes through the daemon", async () => {
  const home = await mkdtemp(join(tmpdir(), "ptools-http-daemon-routes-"));
  const internalStateDirectory = join(home, "state");
  const publicOrigin = `http://127.0.0.1:${await freePort()}`;
  const received: Array<HostOperationDispatchInput> = [];

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // Assemble the daemon side in production order: own the namespace,
          // publish a private credential, create lease authority, then bind RPC.
          const ownership = yield* acquireNodeHostActorDaemonOwnership(
            internalStateDirectory,
          );
          const credential =
            yield* publishNodeHostActorDaemonCredential(ownership);
          const leases = yield* makeNodeHostActorDaemonLeaseManager({
            leaseTtlMs: 60_000,
            zeroLeaseGraceMs: 10_000,
            expirationSweepMs: 100,
            shutdownDrainTimeoutMs: 1_000,
          });
          // Recording manager marks the exact daemon/actor handoff. Everything
          // before dispatch is real; only operation execution is controlled.
          const runtimes = NodeHostRuntimeManager.of({
            dispatch: (input) =>
              Effect.sync(() => {
                received.push(input);
                return responseFor(input);
              }),
          });
          const server = yield* startNodeHostActorDaemonRpcServer(
            ownership,
            credential,
          ).pipe(
            Effect.provideService(
              NodeHostActorDaemonLeaseManager,
              NodeHostActorDaemonLeaseManager.of(leases),
            ),
            Effect.provideService(NodeHostRuntimeManager, runtimes),
          );
          // Discovery must use the same generation-bound ready metadata and
          // credential files as a separately spawned production daemon.
          yield* ownership.publishReadyMetadata({
            origin: server.origin,
            protocolVersion: NODE_HOST_ACTOR_DAEMON_PROTOCOL_VERSION,
          });

          // Build the deployment-owned listener and an ordinary fetch client.
          // The control plane and actor daemon deliberately share this exact root.
          const descriptor = NodeLocalDeploymentDescriptor.make({
            version: 1,
            name: NodeDeploymentName.make("route-test"),
            controlPlanePort: NodeControlPlanePort.make(
              Number(new URL(publicOrigin).port),
            ),
            stateDirectory: NodeDeploymentStateDirectory.make(
              internalStateDirectory,
            ),
            denoExecutableOverride: Option.none(),
          });
          const clientContext = yield* Layer.build(
            Layer.merge(
              NodeHostControlPlaneHttpLive({ descriptor }),
              HostHttpClientFetchLive({
                baseUrl: publicOrigin,
                hostId: "route-host",
                accessToken: NODE_INTERNAL_ACCESS_TOKEN,
              }),
            ),
          );
          const client = Context.get(clientContext, HostHttpClient);

          // Drive every bearer-protected non-Code-Mode endpoint through the
          // shared typed client. Result contents are secondary; dispatch is the
          // behavior under test.
          yield* client.configure({
            config: { mcpServers: {}, executor: Option.none() },
          });
          yield* client.configureSecrets({ secrets: { API_TOKEN: "secret" } });
          yield* client.mcpAuthStatus();
          yield* client.startMcpAuth({ serverName: "remote", force: true });

          // Browser callbacks deliberately bypass Host API bearer auth, so use
          // raw fetch to exercise the actual GET/POST carrier routes.
          const getResponse = yield* Effect.promise(() =>
            fetch(
              `${publicOrigin}/hosts/route-host/oauth/callback/remote?code=get-code`,
            ),
          );
          expect(getResponse.status).toBe(200);
          expect(yield* Effect.promise(() => getResponse.text())).toBe(
            "OAuth GET complete",
          );

          const postResponse = yield* Effect.promise(() =>
            fetch(`${publicOrigin}/hosts/route-host/oauth/callback/remote`, {
              method: "POST",
              body: "code=post-code",
            }),
          );
          expect(postResponse.status).toBe(200);
          expect(yield* Effect.promise(() => postResponse.text())).toBe(
            "OAuth POST complete",
          );
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }

  // The recording actor saw one normalized dispatch per public request, in the
  // same order. This proves no route was handled only inside the HTTP process.
  expect(received.map(({ request }) => request.operation)).toEqual([
    "configure",
    "configure_secrets",
    "mcp_auth_status",
    "start_mcp_auth",
    "complete_mcp_oauth_callback",
    "complete_mcp_oauth_callback",
  ]);
  expect(received.every(({ hostId }) => hostId === "route-host")).toBe(true);
  expect(
    received.every(({ publicOrigin: origin }) => origin === publicOrigin),
  ).toBe(true);
  // Auth middleware supplies caller identity only for credentialed endpoints;
  // callback routes cannot accidentally inherit that capability.
  expect(
    received.slice(0, 4).every(({ caller }) => Option.isSome(caller)),
  ).toBe(true);
  expect(received.slice(4).every(({ caller }) => Option.isNone(caller))).toBe(
    true,
  );

  const [getCallback, postCallback] = received
    .slice(4)
    .map(({ request }) =>
      request.operation === "complete_mcp_oauth_callback"
        ? request.input
        : undefined,
    );
  expect(getCallback).toMatchObject({ method: "GET", provider: "remote" });
  expect(getCallback?.url).toContain("code=get-code");
  expect(getCallback?.bodyText).toBeUndefined();
  expect(postCallback).toMatchObject({
    method: "POST",
    provider: "remote",
    bodyText: "code=post-code",
  });
});

/** Return a schema-valid response matching the operation recorded by the fake actor. */
const responseFor = (
  input: HostOperationDispatchInput,
): HostOperationResponse => {
  switch (input.request.operation) {
    case "configure":
      return {
        operation: "configure",
        result: {
          ok: true,
          configured: true,
          hostId: input.hostId,
          serverCount: 0,
        },
      };
    case "configure_secrets":
      return {
        operation: "configure_secrets",
        result: {
          ok: true,
          configured: true,
          hostId: input.hostId,
          secretCount: 1,
        },
      };
    case "mcp_auth_status":
      return {
        operation: "mcp_auth_status",
        result: {
          ok: false,
          error: { code: "auth_unavailable", message: "recorded auth status" },
        },
      };
    case "start_mcp_auth":
      return {
        operation: "start_mcp_auth",
        result: {
          ok: false,
          error: { code: "auth_unavailable", message: "recorded auth start" },
        },
      };
    case "complete_mcp_oauth_callback":
      return {
        operation: "complete_mcp_oauth_callback",
        result: {
          ok: true,
          response: {
            status: 200,
            body:
              input.request.input.method === "GET"
                ? "OAuth GET complete"
                : "OAuth POST complete",
          },
        },
      };
    case "code_mode":
      return {
        _tag: "HostOperationProtocolFailureResponse",
        error: { code: "unknown_operation", message: "not used by this test" },
      };
  }
};

/** Reserve port 0 briefly so the public server can be built with a known origin. */
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
