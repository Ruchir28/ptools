import type { HostOperationDispatchInput } from "@ptools/host-api";
import { HostInstanceDiscovery } from "@ptools/host-api/effect";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import type { PtoolsWorkerEnv } from "../src/worker/ingress.js";
import { CloudflareHostInstanceDiscoveryLive } from "../src/worker/cloudflareHostInstanceDiscovery.js";
import { WorkerIngressEnv } from "../src/worker/workerIngressEnv.js";

/** Focused caller-side tests for logical host ID to named Durable Object lookup. */
describe("CloudflareHostInstanceDiscoveryLive", () => {
  it("resolves the requested named object once and returns its bound handle", async () => {
    const lookups: string[] = [];
    const rpcInputs: unknown[] = [];
    const env = {
      PTOOLS_CODE_MODE: {
        getByName: (hostId: string) => {
          lookups.push(hostId);
          return {
            handleHostOperation: (input: unknown) => {
              rpcInputs.push(input);
              return Promise.resolve({
                operation: "mcp_auth_status" as const,
                result: {
                  ok: true as const,
                  status: {
                    authUrl: "https://ptools.example/hosts/demo/auth",
                    servers: [],
                  },
                },
              });
            },
          };
        },
      },
    } as unknown as PtoolsWorkerEnv;

    const input: HostOperationDispatchInput = {
      hostId: "demo",
      publicOrigin: "https://ptools.example",
      caller: Option.some({ kind: "HostApiTokenCaller" }),
      request: {
        operation: "mcp_auth_status",
        input: { origin: "https://ptools.example" },
      },
    };

    const response = await Effect.runPromise(
      Effect.gen(function* () {
        const discovery = yield* HostInstanceDiscovery;
        const handle = yield* discovery.resolve("demo");
        return yield* handle.dispatch(input);
      }).pipe(
        Effect.provide(
          CloudflareHostInstanceDiscoveryLive.pipe(
            Layer.provide(Layer.succeed(WorkerIngressEnv, env)),
          ),
        ),
      ),
    );

    expect(lookups).toEqual(["demo"]);
    expect(rpcInputs).toHaveLength(1);
    expect(rpcInputs[0]).toMatchObject({
      hostId: "demo",
      publicOrigin: "https://ptools.example",
      caller: { kind: "HostApiTokenCaller" },
    });
    expect(response).toMatchObject({
      operation: "mcp_auth_status",
      result: { ok: true },
    });
  });
});
