/**
 * Unit coverage for the caller-side HostInstanceHandle over the daemon connection.
 *
 * Background — the handle binds one logical hostId to an already-owned daemon
 * connection. It is the complete schema/transport seam: reject cross-host use,
 * encode the normalized dispatch value, make exactly one private RPC call, then
 * decode the response and translate transport failures. It must not interpret
 * individual Host operations.
 *
 * What this proves:
 *   1. A handle bound to hostId A rejects operations for hostId B before any
 *      daemon RPC (no accidental cross-host dispatch).
 *   2. On a matching hostId, the handle schema-encodes the full
 *      HostOperationDispatchInput, forwards that encoded payload, and
 *      schema-decodes the complete HostOperationResponse.
 *   3. NodeDaemonConnectionError from the transport is mapped into
 *      HostOperationDispatchError (with the original cause preserved).
 *
 * The connection is a fake; no daemon or RPC transport is started.
 */
import {
  ConfigureHostResponse,
  HostOperationDispatchInput,
  type EncodedHostOperationDispatchInput,
} from "@ptools/host-api";
import { HostOperationDispatchError } from "@ptools/host-api/effect";
import { Effect, Option, Schema } from "effect";
import { expect, it } from "vitest";
import { makeNodeDaemonHostInstanceHandle } from "../src/nodeDaemonHostInstanceHandle.js";
import { NodeDaemonConnectionError } from "../src/services/nodeHostActorDaemonConnection.js";

const operation = HostOperationDispatchInput.make({
  hostId: "alpha",
  publicOrigin: "https://ptools.example",
  caller: Option.some({ kind: "HostApiTokenCaller" as const }),
  request: {
    operation: "configure" as const,
    input: { config: { mcpServers: {}, executor: Option.none() } },
  },
});

const response = ConfigureHostResponse.make({
  operation: "configure",
  result: { ok: true, configured: true, hostId: "alpha", serverCount: 0 },
});

it("rejects a bound host mismatch before daemon RPC", async () => {
  let calls = 0;
  // Handle is bound to "other"; the operation targets "alpha" → fail locally.
  const handle = makeNodeDaemonHostInstanceHandle({
    hostId: "other",
    connection: {
      handleHostOperation: () => {
        calls += 1;
        return Effect.die("must not run");
      },
    },
  });

  const error = await Effect.runPromise(
    handle.dispatch(operation).pipe(Effect.flip),
  );
  expect(error).toBeInstanceOf(HostOperationDispatchError);
  expect(calls).toBe(0);
});

it("schema-encodes the complete input and decodes the complete response", async () => {
  let forwarded: EncodedHostOperationDispatchInput | undefined;
  const encodedResponse = await Effect.runPromise(
    Schema.encodeEffect(ConfigureHostResponse)(response),
  );
  const handle = makeNodeDaemonHostInstanceHandle({
    hostId: "alpha",
    connection: {
      handleHostOperation: (input) => {
        forwarded = input;
        return Effect.succeed(encodedResponse);
      },
    },
  });

  await expect(Effect.runPromise(handle.dispatch(operation))).resolves.toEqual(
    response,
  );
  // Wire boundary is encoded JSON-shaped input, not the domain class instance.
  expect(forwarded).toEqual(
    await Effect.runPromise(
      Schema.encodeEffect(HostOperationDispatchInput)(operation),
    ),
  );
});

it("maps daemon connection failures to HostOperationDispatchError", async () => {
  const handle = makeNodeDaemonHostInstanceHandle({
    hostId: "alpha",
    connection: {
      handleHostOperation: () =>
        Effect.fail(
          new NodeDaemonConnectionError({
            phase: "operation",
            message: "network unavailable",
          }),
        ),
    },
  });

  const error = await Effect.runPromise(
    handle.dispatch(operation).pipe(Effect.flip),
  );
  expect(error).toBeInstanceOf(HostOperationDispatchError);
  expect(error.cause).toBeInstanceOf(NodeDaemonConnectionError);
});
