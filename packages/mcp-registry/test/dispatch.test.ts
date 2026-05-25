import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  InvalidToolArguments,
  ToolNotFound,
  UpstreamAuthRequired,
} from "../src/errors.js";
import { dispatchToolCall } from "../src/dispatch.js";
import type {
  ConnectedMcpClient,
  DiscoveredMcpTool,
} from "../src/types.js";

describe("dispatchToolCall", () => {
  it("dispatches JS-facing calls to original MCP tool names", async () => {
    const calls: Array<unknown> = [];
    const clients: ReadonlyArray<ConnectedMcpClient> = [
      {
        serverName: "github",
        jsServerName: "github",
        client: fakeClient({
          callTool: async (params: unknown) => {
            calls.push(params);

            return {
              content: [{ type: "text", text: "created" }],
              structuredContent: { ok: true },
            };
          },
        }),
      },
    ];

    const result = await Effect.runPromise(
      dispatchToolCall(clients, [githubCreateIssueTool], {
        jsServerName: "github",
        jsToolName: "create_issue",
        arguments: { title: "Ship registry" },
      }),
    );

    expect(calls).toEqual([
      {
        name: "create-issue",
        arguments: { title: "Ship registry" },
      },
    ]);
    expect(result).toEqual({
      content: [{ type: "text", text: "created" }],
      structuredContent: { ok: true },
    });
  });

  it("fails when the JS server/tool pair is unknown", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        dispatchToolCall([], [githubCreateIssueTool], {
          jsServerName: "github",
          jsToolName: "missing",
          arguments: {},
        }),
      ),
    );

    expect(Either.isLeft(result)).toBe(true);

    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(ToolNotFound);
      expect(result.left.toolName).toBe("missing");
    }
  });

  it("fails before dispatch when arguments are not an object", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        dispatchToolCall([], [githubCreateIssueTool], {
          jsServerName: "github",
          jsToolName: "create_issue",
          arguments: "not an object",
        }),
      ),
    );

    expect(Either.isLeft(result)).toBe(true);

    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(InvalidToolArguments);
      expect(result.left._tag).toBe("InvalidToolArguments");
    }

    if (Either.isLeft(result) && result.left._tag === "InvalidToolArguments") {
      expect(result.left.value).toBe("not an object");
    }
  });

  it("omits authUrl from auth errors when auth status is unavailable", async () => {
    const clients: ReadonlyArray<ConnectedMcpClient> = [
      {
        serverName: "github",
        jsServerName: "github",
        client: fakeClient({
          callTool: async () => {
            throw new UnauthorizedError();
          },
        }),
      },
    ];

    const result = await Effect.runPromise(
      Effect.either(
        dispatchToolCall(clients, [githubCreateIssueTool], {
          jsServerName: "github",
          jsToolName: "create_issue",
          arguments: { title: "Ship registry" },
        }),
      ),
    );

    expect(Either.isLeft(result)).toBe(true);

    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(UpstreamAuthRequired);
      expect(result.left).not.toHaveProperty("authUrl");
    }
  });

  it("includes auth URLs from auth status when available", async () => {
    const clients: ReadonlyArray<ConnectedMcpClient> = [
      {
        serverName: "github",
        jsServerName: "github",
        client: fakeClient({
          callTool: async () => {
            throw new UnauthorizedError();
          },
        }),
      },
    ];

    const result = await Effect.runPromise(
      Effect.either(
        dispatchToolCall(
          clients,
          [githubCreateIssueTool],
          {
            jsServerName: "github",
            jsToolName: "create_issue",
            arguments: { title: "Ship registry" },
          },
          {
            authUrl: "http://127.0.0.1:9999/auth",
            servers: [
              {
                serverName: "github",
                jsServerName: "github",
                transport: "http",
                status: "requires_auth",
                authUrl: "http://127.0.0.1:9999/auth",
                authorizeUrl: "http://127.0.0.1:9999/auth/github",
              },
            ],
          },
        ),
      ),
    );

    expect(Either.isLeft(result)).toBe(true);

    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(UpstreamAuthRequired);
      expect(result.left).toMatchObject({
        authUrl: "http://127.0.0.1:9999/auth",
        authorizeUrl: "http://127.0.0.1:9999/auth/github",
      });
    }
  });
});

const githubCreateIssueTool: DiscoveredMcpTool = {
  serverName: "github",
  originalToolName: "create-issue",
  jsServerName: "github",
  jsToolName: "create_issue",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
    },
  },
};

const fakeClient = (methods: {
  readonly callTool: (params: unknown) => Promise<unknown>;
}): Client => methods as unknown as Client;
