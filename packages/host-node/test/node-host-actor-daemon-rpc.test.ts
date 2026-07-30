/**
 * Integration tests for the private RPC boundary in one process. The loopback
 * HTTP listener, JSON serialization, middleware, and ownership identity are
 * real. The actor manager is a small test service so assertions can isolate
 * what crosses the RPC boundary without activating storage, MCP, or Deno.
 */
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import type { HostOperationDispatchInput } from "@ptools/host-api";
import { Effect, FileSystem, Result, Layer, Option, Ref } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NODE_HOST_ACTOR_DAEMON_CREDENTIAL_HEADER,
  NODE_HOST_ACTOR_DAEMON_PROTOCOL_HEADER,
  NODE_HOST_ACTOR_DAEMON_PROTOCOL_VERSION,
  NodeHostActorDaemonRpcs,
} from "../src/hostActorDaemon/rpc/nodeHostActorDaemonRpcContracts.js";
import { acquireNodeHostActorDaemonOwnership } from "../src/hostActorDaemon/ownership/nodeHostActorDaemonOwnership.js";
import {
  NodeHostActorRuntimeError,
  NodeHostActorRuntimePhase,
} from "../src/hostActorDaemon/actorRuntime/nodeHostActorRuntimeError.js";
import { startNodeHostActorDaemonRpcServer } from "../src/hostActorDaemon/rpc/nodeHostActorDaemonRpcServer.js";
import {
  makeNodeHostActorDaemonLeaseManager,
  NodeHostActorDaemonLeaseManager,
} from "../src/hostActorDaemon/leases/services/nodeHostActorDaemonLeaseManager.js";
import { NodeHostRuntimeManager } from "../src/hostActorDaemon/actorRuntime/services/nodeHostRuntimeManager.js";

const directories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Node host-actor daemon Effect RPC server", () => {
  it("authenticates, serves health and leases, and forwards decoded input unchanged", async () => {
    // Flow:
    // 1. construct daemon ownership, lease authority, and a recording actor
    //    manager, then bind a real ephemeral loopback RPC listener
    // 2. connect with matching credential/version headers and verify health
    // 3. acquire a lease and send a complete host operation through JSON RPC
    // 4. prove dispatch received the decoded input unchanged
    // 5. prove internal runtime causes are removed from wire-safe RPC errors
    const directory = await makeDirectory();
    const credential = "test-daemon-credential";

    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const ownership =
            yield* acquireNodeHostActorDaemonOwnership(directory);
          const leases = yield* makeNodeHostActorDaemonLeaseManager({
            leaseTtlMs: 1_000,
            zeroLeaseGraceMs: 1_000,
            expirationSweepMs: 20,
            shutdownDrainTimeoutMs: 1_000,
          });
          // This Ref records the exact value handed from the RPC handler to the
          // actor manager, making the no-interpretation assertion observable.
          const received = yield* Ref.make<
            Option.Option<HostOperationDispatchInput>
          >(Option.none());
          const runtimes = NodeHostRuntimeManager.of({
            dispatch: (input) =>
              input.hostId === "runtime-failure"
                ? Effect.fail(
                    new NodeHostActorRuntimeError({
                      hostId: input.hostId,
                      phase: NodeHostActorRuntimePhase.Execute,
                      message: "test runtime failure",
                      cause: new Error("must not cross RPC"),
                    }),
                  )
                : Ref.set(received, Option.some(input)).pipe(
                    Effect.as({
                      _tag: "HostOperationProtocolFailureResponse" as const,
                      error: {
                        code: "host_unavailable" as const,
                        message: "test response",
                      },
                    }),
                  ),
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
          const client = yield* makeClient(server.origin, credential);

          const health = yield* client.Health();
          expect(health.ownerGeneration).toBe(ownership.ownerGeneration);
          expect(health.protocolVersion).toBe(
            NODE_HOST_ACTOR_DAEMON_PROTOCOL_VERSION,
          );

          const lease = yield* client.AcquireServerLease();
          const input: HostOperationDispatchInput = {
            hostId: "host-a",
            publicOrigin: "http://127.0.0.1:3000",
            caller: Option.none(),
            request: {
              operation: "configure_secrets",
              input: { secrets: {} },
            },
          };
          const response = yield* client.HandleHostOperation({
            leaseId: lease.leaseId,
            input,
          });
          expect("_tag" in response ? response._tag : "operation").toBe(
            "HostOperationProtocolFailureResponse",
          );
          expect(yield* Ref.get(received)).toEqual(Option.some(input));

          // Trigger a daemon-internal error containing a real cause. The client
          // should receive its declared projection, never that private cause.
          const runtimeFailure = yield* client
            .HandleHostOperation({
              leaseId: lease.leaseId,
              input: { ...input, hostId: "runtime-failure" },
            })
            .pipe(Effect.result);
          expect(Result.isFailure(runtimeFailure)).toBe(true);
          if (Result.isFailure(runtimeFailure)) {
            expect(runtimeFailure.failure._tag).toBe(
              "NodeHostActorRuntimeRpcError",
            );
            expect("cause" in runtimeFailure.failure).toBe(false);
          }

          yield* client.ReleaseServerLease({ leaseId: lease.leaseId });
        }),
      ),
    );
  });

  it("rejects an invalid credential or protocol version with declared RPC errors", async () => {
    // Keep the server valid and vary one client header at a time. The actor
    // manager dies if called, proving middleware rejects both requests before
    // any procedure handler can dispatch work.
    const directory = await makeDirectory();

    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const ownership =
            yield* acquireNodeHostActorDaemonOwnership(directory);
          const leases = yield* makeNodeHostActorDaemonLeaseManager({
            leaseTtlMs: 1_000,
            zeroLeaseGraceMs: 1_000,
            expirationSweepMs: 20,
            shutdownDrainTimeoutMs: 1_000,
          });
          const runtimes = NodeHostRuntimeManager.of({
            dispatch: () => Effect.die("unexpected dispatch"),
          });
          const server = yield* startNodeHostActorDaemonRpcServer(
            ownership,
            "correct-credential",
          ).pipe(
            Effect.provideService(
              NodeHostActorDaemonLeaseManager,
              NodeHostActorDaemonLeaseManager.of(leases),
            ),
            Effect.provideService(NodeHostRuntimeManager, runtimes),
          );
          const client = yield* makeClient(server.origin, "wrong-credential");
          const result = yield* client.Health().pipe(Effect.result);
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe("NodeDaemonUnauthorized");
          }

          // Correct authentication isolates protocol-version validation from
          // the credential failure asserted immediately above.
          const wrongVersionClient = yield* makeClient(
            server.origin,
            "correct-credential",
            "incompatible",
          );
          const versionResult = yield* wrongVersionClient
            .Health()
            .pipe(Effect.result);
          expect(Result.isFailure(versionResult)).toBe(true);
          if (Result.isFailure(versionResult)) {
            expect(versionResult.failure._tag).toBe(
              "NodeDaemonProtocolVersionMismatch",
            );
          }
        }),
      ),
    );
  });
});

/**
 * Build a typed JSON client and attach the two headers checked by daemon
 * middleware to every HTTP request.
 */
const makeClient = (
  origin: string,
  credential: string,
  protocolVersion: string = NODE_HOST_ACTOR_DAEMON_PROTOCOL_VERSION,
) => {
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
          protocolVersion,
        ),
      ),
    ),
  }).pipe(Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]));
  return RpcClient.make(NodeHostActorDaemonRpcs).pipe(Effect.provide(protocol));
};

const makeDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "ptools-daemon-rpc-"));
  directories.push(directory);
  return directory;
};

const run = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem>,
): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));
