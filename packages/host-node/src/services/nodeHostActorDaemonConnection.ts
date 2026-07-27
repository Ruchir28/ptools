import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import {
  HostOperationDispatchInput,
  HostOperationResponse,
  type EncodedHostOperationDispatchInput,
} from "@ptools/host-api";
import {
  Data,
  Effect,
  ExecutionStrategy,
  Exit,
  Fiber,
  Layer,
  Schema,
  Scope,
} from "effect";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { NodeHostActorRuntimeOptions } from "../hostActorDaemon/actorRuntime/contracts/nodeHostActorRuntimeOptions.js";
import {
  NODE_HOST_ACTOR_DAEMON_CREDENTIAL_FILE,
  readNodeHostActorDaemonReadyMetadata,
  type NodeHostActorDaemonReadyMetadata,
} from "../hostActorDaemon/ownership/nodeHostActorDaemonOwnership.js";
import {
  NODE_HOST_ACTOR_DAEMON_CREDENTIAL_HEADER,
  NODE_HOST_ACTOR_DAEMON_PROTOCOL_HEADER,
  NODE_HOST_ACTOR_DAEMON_PROTOCOL_VERSION,
  NODE_HOST_ACTOR_DAEMON_RPC_PATH,
  NodeHostActorDaemonRpcs,
  NodeHostActorRuntimeRpcError,
} from "../hostActorDaemon/rpc/nodeHostActorDaemonRpcContracts.js";
import * as NodeContext from "@effect/platform-node/NodeContext";
import {
  NodeHostActorDaemonSpawner,
  type NodeHostActorDaemonSpawnerOperations,
} from "./nodeHostActorDaemonSpawner.js";

export type EncodedHostOperationResponse = Schema.Schema.Encoded<
  typeof HostOperationResponse
>;

export class NodeDaemonConnectionError extends Data.TaggedError(
  "NodeDaemonConnectionError",
)<{
  readonly phase:
    | "discover"
    | "startup"
    | "connect"
    | "protocol"
    | "lease"
    | "heartbeat"
    | "operation"
    | "release";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface NodeDaemonDiscoveryOptions extends NodeHostActorRuntimeOptions {
  readonly startupTimeoutMs?: number;
  readonly discoveryPollMs?: number;
  readonly heartbeatIntervalMs?: number;
}

export interface NodeHostActorDaemonConnectionOperations {
  readonly handleHostOperation: (
    input: EncodedHostOperationDispatchInput,
  ) => Effect.Effect<EncodedHostOperationResponse, NodeDaemonConnectionError>;
}

interface ConnectedDaemon {
  readonly metadata: NodeHostActorDaemonReadyMetadata;
  readonly credential: string;
  readonly client: DaemonRpcClient;
  readonly leaseId: string;
  readonly scope: Scope.CloseableScope;
}

type DaemonRpcClient = Effect.Effect.Success<ReturnType<typeof makeRpcClient>>;

/**
 * Maintains one authenticated, leased connection from a public Node Host HTTP
 * server to the authoritative actor daemon for its state namespace.
 */
export class NodeHostActorDaemonConnection extends Effect.Service<NodeHostActorDaemonConnection>()(
  "@ptools/host-node/NodeHostActorDaemonConnection",
  {
    scoped: (options: NodeDaemonDiscoveryOptions) => makeConnection(options),
  },
) {}

const makeConnection = (
  options: NodeDaemonDiscoveryOptions,
): Effect.Effect<
  NodeHostActorDaemonConnectionOperations,
  NodeDaemonConnectionError,
  Scope.Scope | NodeHostActorDaemonSpawner
> =>
  Effect.gen(function* () {
    const parentScope = yield* Effect.scope;
    const spawner = yield* NodeHostActorDaemonSpawner;
    const semaphore = yield* Effect.makeSemaphore(1);
    let active = yield* connectOrStart(options, parentScope, spawner);

    const replaceConnection = (expected: ConnectedDaemon) =>
      semaphore.withPermits(1)(
        Effect.gen(function* () {
          // Another failed caller may already have refreshed this generation
          // while this fiber waited for the reconnect permit.
          if (active !== expected) return active;

          const next = yield* connectOrStart(options, parentScope, spawner);
          active = next;
          yield* closeConnected(expected);
          return next;
        }),
      );

    const heartbeat = yield* Effect.forever(
      Effect.sleep(options.heartbeatIntervalMs ?? 5_000).pipe(
        Effect.zipRight(
          Effect.gen(function* () {
            const connection = active;
            yield* connection.client
              .RenewServerLease({ leaseId: connection.leaseId })
              .pipe(
                Effect.catchAll(() =>
                  replaceConnection(connection).pipe(
                    Effect.asVoid,
                    Effect.catchAll((error) =>
                      Effect.logWarning(
                        `Node daemon heartbeat reconnect failed: ${error.message}`,
                      ),
                    ),
                  ),
                ),
              );
          }),
        ),
      ),
    ).pipe(Effect.forkScoped);

    yield* Effect.addFinalizer(() =>
      Fiber.interrupt(heartbeat).pipe(
        Effect.zipRight(Effect.suspend(() => closeConnected(active))),
      ),
    );

    const call = (input: EncodedHostOperationDispatchInput) =>
      Schema.decodeUnknown(HostOperationDispatchInput)(input).pipe(
        Effect.mapError(
          (cause) =>
            new NodeDaemonConnectionError({
              phase: "operation",
              message:
                "Encoded host operation did not match the shared schema.",
              cause,
            }),
        ),
        Effect.flatMap((decoded) =>
          Effect.gen(function* () {
            const connection = active;
            return yield* connection.client
              .HandleHostOperation({
                leaseId: connection.leaseId,
                input: decoded,
              })
              .pipe(
                Effect.catchAll((cause) =>
                  cause instanceof NodeHostActorRuntimeRpcError
                    ? Effect.fail(
                        new NodeDaemonConnectionError({
                          phase: "operation",
                          message: cause.message,
                          cause,
                        }),
                      )
                    : // The daemon may have completed a mutating operation
                      // before transport failed. Reconnect for later calls, but
                      // never replay when its outcome is unknown.
                      replaceConnection(connection).pipe(
                        Effect.ignore,
                        Effect.zipRight(
                          Effect.fail(
                            new NodeDaemonConnectionError({
                              phase: "operation",
                              message:
                                "Daemon host operation transport failed; the connection was refreshed without replaying the operation.",
                              cause,
                            }),
                          ),
                        ),
                      ),
                ),
              );
          }),
        ),
        Effect.flatMap((response) =>
          Schema.encode(HostOperationResponse)(response).pipe(
            Effect.mapError(
              (cause) =>
                new NodeDaemonConnectionError({
                  phase: "operation",
                  message: "Daemon response could not be encoded.",
                  cause,
                }),
            ),
          ),
        ),
      );

    return NodeHostActorDaemonConnection.make({ handleHostOperation: call });
  });

const connectOrStart = (
  options: NodeDaemonDiscoveryOptions,
  parentScope: Scope.Scope,
  spawner: NodeHostActorDaemonSpawnerOperations,
): Effect.Effect<ConnectedDaemon, NodeDaemonConnectionError> =>
  connectReadyDaemon(options, parentScope).pipe(
    Effect.catchAll((error) =>
      error.phase === "protocol"
        ? Effect.fail(error)
        : spawner.start(options).pipe(
            Effect.mapError(
              (cause) =>
                new NodeDaemonConnectionError({
                  phase: "startup",
                  message: cause.message,
                  cause,
                }),
            ),
            Effect.zipRight(discoverAndConnect(options, parentScope)),
          ),
    ),
  );

const discoverAndConnect = (
  options: NodeDaemonDiscoveryOptions,
  parentScope: Scope.Scope,
): Effect.Effect<ConnectedDaemon, NodeDaemonConnectionError> =>
  Effect.gen(function* () {
    const deadline = Date.now() + (options.startupTimeoutMs ?? 10_000);
    let lastCause: unknown;
    while (Date.now() < deadline) {
      const attempt = yield* connectReadyDaemon(options, parentScope).pipe(
        Effect.exit,
      );
      if (Exit.isSuccess(attempt)) return attempt.value;
      lastCause = attempt.cause;
      yield* Effect.sleep(options.discoveryPollMs ?? 50);
    }
    return yield* new NodeDaemonConnectionError({
      phase: "discover",
      message: "Timed out locating a healthy Node host-actor daemon.",
      cause: lastCause,
    });
  });

const connectReadyDaemon = (
  options: NodeDaemonDiscoveryOptions,
  parentScope: Scope.Scope,
): Effect.Effect<ConnectedDaemon, NodeDaemonConnectionError> =>
  Effect.gen(function* () {
    const metadata = yield* readNodeHostActorDaemonReadyMetadata(
      options.internalStateDirectory,
    ).pipe(
      Effect.provide(NodeContext.layer),
      Effect.mapError(
        (cause) =>
          new NodeDaemonConnectionError({
            phase: "discover",
            message: "Unable to read Node daemon ready metadata.",
            cause,
          }),
      ),
    );
    if (metadata.protocolVersion !== NODE_HOST_ACTOR_DAEMON_PROTOCOL_VERSION) {
      return yield* new NodeDaemonConnectionError({
        phase: "protocol",
        message: `Node daemon protocol ${metadata.protocolVersion} is incompatible with ${NODE_HOST_ACTOR_DAEMON_PROTOCOL_VERSION}.`,
      });
    }
    const credential = yield* Effect.tryPromise({
      try: () =>
        readFile(
          join(
            options.internalStateDirectory,
            NODE_HOST_ACTOR_DAEMON_CREDENTIAL_FILE,
          ),
          "utf8",
        ),
      catch: (cause) =>
        new NodeDaemonConnectionError({
          phase: "connect",
          message: "Unable to read the private Node daemon credential.",
          cause,
        }),
    });
    // Each replaceable connection owns a child scope: reconnect can close it
    // early, while the service scope remains the shutdown safety net.
    const scope = yield* Scope.fork(parentScope, ExecutionStrategy.sequential);

    return yield* Effect.gen(function* () {
      const client = yield* makeRpcClient(metadata.origin, credential);
      const health = yield* client.Health().pipe(
        Effect.mapError(
          (cause) =>
            new NodeDaemonConnectionError({
              phase: "connect",
              message: "Node daemon health handshake failed.",
              cause,
            }),
        ),
      );
      if (
        health.ownerGeneration !== metadata.ownerGeneration ||
        health.protocolVersion !== NODE_HOST_ACTOR_DAEMON_PROTOCOL_VERSION
      ) {
        return yield* new NodeDaemonConnectionError({
          phase: "connect",
          message:
            "Node daemon ready metadata did not match its authenticated health identity.",
        });
      }
      const lease = yield* Effect.acquireRelease(
        client.AcquireServerLease().pipe(
          Effect.mapError(
            (cause) =>
              new NodeDaemonConnectionError({
                phase: "lease",
                message: "Unable to acquire a Node daemon server lease.",
                cause,
              }),
          ),
        ),
        (lease) =>
          client.ReleaseServerLease({ leaseId: lease.leaseId }).pipe(
            Effect.asVoid,
            Effect.mapError(
              (cause) =>
                new NodeDaemonConnectionError({
                  phase: "release",
                  message: "Unable to release the Node daemon server lease.",
                  cause,
                }),
            ),
            Effect.ignoreLogged,
          ),
      );
      return {
        metadata,
        credential,
        client,
        leaseId: lease.leaseId,
        scope,
      } as ConnectedDaemon;
    }).pipe(
      Scope.extend(scope),
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
  });

const closeConnected = (connected: ConnectedDaemon): Effect.Effect<void> =>
  Scope.close(connected.scope, Exit.void);

const makeRpcClient = (origin: string, credential: string) => {
  const protocol = RpcClient.layerProtocolHttp({
    url: `${origin}${NODE_HOST_ACTOR_DAEMON_RPC_PATH}`,
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
