import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodeModeSearchRequest } from "@ptools/code-mode-api";
import {
  HostClient,
  HostClientLayer,
  HostTransport,
} from "../src/services/index.js";
import {
  parseHostApiRequest,
  parseHostApiResponse,
  type HostApiResponse,
} from "../src/index.js";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("host-api source layout", () => {
  it("keeps reusable DTOs under contracts and Effect services under services", async () => {
    await expect(fileExists(join(packageRoot, "src/contracts"))).resolves.toBe(
      true,
    );
    await expect(fileExists(join(packageRoot, "src/services"))).resolves.toBe(
      true,
    );
    await expect(fileExists(join(packageRoot, "src/effect"))).resolves.toBe(
      false,
    );

    for (const forbiddenRootFile of [
      "configureHostSchema.ts",
      "hostApiSchema.ts",
      "hostAuthSchema.ts",
      "hostCodeModeSchema.ts",
      "hostSecretsSchema.ts",
    ]) {
      await expect(
        fileExists(join(packageRoot, "src", forbiddenRootFile)),
      ).resolves.toBe(false);
    }
  });
});

describe("host-api schemas", () => {
  it("decodes code_mode requests and responses", async () => {
    const request = await Effect.runPromise(
      parseHostApiRequest({
        operation: "code_mode",
        input: {
          operation: "search",
          input: { query: "github" },
        },
      }),
    );

    expect(request.operation).toBe("code_mode");

    const response: HostApiResponse = {
      operation: "code_mode",
      result: {
        ok: true,
        response: {
          operation: "search",
          output: { actions: [], diagnostics: [] },
        },
      },
    };

    await expect(
      Effect.runPromise(parseHostApiResponse(response)),
    ).resolves.toEqual(response);
  });

  it("decodes structured configure input", async () => {
    const request = await Effect.runPromise(
      parseHostApiRequest({
        operation: "configure",
        input: {
          config: {
            mcpServers: {
              github: { url: "https://example.com/mcp" },
            },
          },
        },
      }),
    );

    expect(request.operation).toBe("configure");
  });

  it("decodes OAuth callback completion request and browser response payload", async () => {
    const request = await Effect.runPromise(
      parseHostApiRequest({
        operation: "complete_mcp_oauth_callback",
        input: {
          origin: "https://ptools.example",
          provider: "github",
          method: "GET",
          url: "https://ptools.example/hosts/demo/oauth/callback/github?code=abc&state=xyz",
        },
      }),
    );

    expect(request.operation).toBe("complete_mcp_oauth_callback");

    const response: HostApiResponse = {
      operation: "complete_mcp_oauth_callback",
      result: {
        ok: true,
        response: {
          status: 200,
          headers: { "content-type": "text/html" },
          body: "<p>Connected</p>",
        },
      },
    };

    await expect(
      Effect.runPromise(parseHostApiResponse(response)),
    ).resolves.toEqual(response);
  });
});

describe("HostClientLayer", () => {
  it("builds host.codeMode from HostTransport", async () => {
    const response: HostApiResponse = {
      operation: "code_mode",
      result: {
        ok: true,
        response: {
          operation: "search",
          output: { actions: [], diagnostics: [] },
        },
      },
    };
    const transport = Layer.succeed(HostTransport, {
      call: () => Effect.succeed(response),
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const host = yield* HostClient;
        return yield* host.codeMode.call({
          operation: "search",
          input: CodeModeSearchRequest.make({
            query: "github",
            provider: Option.none(),
            limit: Option.none(),
          }),
        });
      }).pipe(Effect.provide(HostClientLayer.pipe(Layer.provide(transport)))),
    );

    expect(result.operation).toBe("search");
  });
});

const fileExists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );
