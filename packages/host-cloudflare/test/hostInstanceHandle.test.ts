import { HostOperationDispatchError } from "@ptools/host-api/effect";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { decodeCloudflareHostOperationRpcInput } from "../src/objects/codeModeObject/rpc.js";
import { makeCloudflareDurableObjectHostInstanceHandle } from "../src/worker/cloudflareDurableObjectHostInstanceHandle.js";

const operation = (hostId: string) => ({
  hostId,
  publicOrigin: "https://ptools.example",
  caller: Option.none(),
  request: {
    operation: "mcp_auth_status" as const,
    input: { origin: "https://ptools.example" },
  },
});

describe("CloudflareDurableObjectHostInstanceHandle", () => {
  it("forwards one complete operation through handleHostOperation", async () => {
    const seen: unknown[] = [];
    const handle = makeCloudflareDurableObjectHostInstanceHandle({
      hostId: "demo",
      stub: {
        handleHostOperation: (input) => {
          seen.push(input);
          return Promise.resolve({
            operation: "mcp_auth_status",
            result: {
              ok: true,
              status: { authUrl: "https://ptools.example/auth", servers: [] },
            },
          });
        },
      },
    });

    await Effect.runPromise(handle.dispatch(operation("demo")));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ hostId: "demo" });
  });

  it("maps a rejected Workers RPC call to HostOperationDispatchError", async () => {
    const handle = makeCloudflareDurableObjectHostInstanceHandle({
      hostId: "demo",
      stub: {
        handleHostOperation: () => Promise.reject(new Error("RPC unavailable")),
      },
    });

    const error = await Effect.runPromise(
      Effect.flip(handle.dispatch(operation("demo"))),
    );
    expect(error).toBeInstanceOf(HostOperationDispatchError);
    expect(error.message).toContain("Cloudflare host operation RPC failed");
  });

  it("rejects a malformed response returned across Workers RPC", async () => {
    const handle = makeCloudflareDurableObjectHostInstanceHandle({
      hostId: "demo",
      stub: {
        handleHostOperation: () =>
          Promise.resolve({ unexpected: true } as never),
      },
    });

    const exit = await Effect.runPromiseExit(
      handle.dispatch(operation("demo")),
    );
    expect(exit._tag).toBe("Failure");
    expect(String(exit)).toContain("invalid response");
  });

  it("restores the internal caller Option at the receiving RPC codec", async () => {
    const decoded = await Effect.runPromise(
      decodeCloudflareHostOperationRpcInput({
        hostId: "demo",
        publicOrigin: "https://ptools.example",
        caller: { kind: "HostApiTokenCaller" },
        request: {
          operation: "mcp_auth_status",
          input: { origin: "https://ptools.example" },
        },
      }),
    );

    expect(Option.getOrThrow(decoded.caller)).toEqual({
      kind: "HostApiTokenCaller",
    });
  });

  it("rejects malformed dispatch data at the receiving RPC codec", async () => {
    const exit = await Effect.runPromiseExit(
      decodeCloudflareHostOperationRpcInput({
        hostId: "demo",
        publicOrigin: "https://ptools.example",
        request: { unexpected: true },
      }),
    );

    expect(exit._tag).toBe("Failure");
  });

  it("rejects a host mismatch before RPC", async () => {
    let called = false;
    const handle = makeCloudflareDurableObjectHostInstanceHandle({
      hostId: "bound",
      stub: {
        handleHostOperation: () => {
          called = true;
          throw new Error("must not be called");
        },
      },
    });

    const exit = await Effect.runPromiseExit(
      handle.dispatch(operation("other")),
    );
    expect(exit._tag).toBe("Failure");
    expect(called).toBe(false);
  });
});
