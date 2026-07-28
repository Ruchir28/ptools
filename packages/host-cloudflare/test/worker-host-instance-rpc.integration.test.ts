/// <reference path="./worker-env.d.ts" />

/**
 * Local workerd integration tests for the Worker-to-Durable-Object instance
 * seam. They verify named-object selection, complete normalized principal and
 * operation forwarding, and the receiver's independent host-identity check.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { codeModeObjectTestCallsForHost } from "./codeModeObjectTestState.js";
import {
  authHeaders,
  codeModeSearchProvidersBody,
  configureHost,
  emptyConfigBody,
  handleRequest,
  uniqueHostId,
} from "./support/cloudflareWorkerTestClient.js";

describe("worker host instance rpc", () => {
  it("looks up the Durable Object by route host ID and calls typed RPC", async () => {
    const hostId = uniqueHostId();
    await configureHost(hostId, emptyConfigBody());

    const response = await handleRequest(`/hosts/${hostId}/code-mode`, {
      method: "POST",
      headers: authHeaders(),
      body: codeModeSearchProvidersBody(),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      operation: "code_mode",
      result: {
        ok: true,
        response: {
          operation: "search_providers",
          output: { providers: [], diagnostics: [] },
        },
      },
    });
    expect(codeModeObjectTestCallsForHost(hostId)).toEqual([
      {
        hostId,
        request: { operation: "search_providers" },
        origin: "https://ptools.example",
        caller: { kind: "HostApiTokenCaller" },
      },
    ]);
  });

  it("rejects a host mismatch inside the receiving Durable Object", async () => {
    const stub = env.PTOOLS_CODE_MODE.getByName(uniqueHostId());
    const response = await stub.handleHostOperation({
      hostId: "different-host",
      publicOrigin: "https://ptools.example",
      caller: { kind: "HostApiTokenCaller" },
      request: {
        operation: "mcp_auth_status",
      },
    });

    expect(response).toMatchObject({
      _tag: "HostOperationProtocolFailureResponse",
      error: { code: "host_unavailable" },
    });
  });
});
