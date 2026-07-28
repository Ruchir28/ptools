/**
 * End-to-end coverage: embedded Host clients → public HTTP → shared daemon.
 *
 * Background — each embedded client owns a listener and one daemon lease. Two
 * clients selecting the same internalStateDirectory and hostId intentionally
 * address one authoritative actor. Configuration is explicit Host API work;
 * neither constructor reads a config file or warms Code Mode.
 *
 * What this proves:
 *   1. Explicit configure followed by Code Mode reaches a real daemon actor.
 *   2. Two listeners/leases share that actor, and closing one leaves the other
 *      functional.
 *
 * HTTP, daemon startup/RPC, MCP stdio, and Deno are real.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodeModeSearchRequest } from "@ptools/code-mode-api";
import { UserPtoolsConfig } from "@ptools/config/contracts";
import { Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { startEmbeddedNodeHost } from "../src/clientHandles.js";

const fixturePath = fileURLToPath(
  new URL(
    "../../mcp-registry/test/fixtures/stdio-mcp-server.ts",
    import.meta.url,
  ),
);

const hasDeno = (() => {
  try {
    execFileSync("deno", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasDeno)("public Host API to daemon integration", () => {
  it("shares one explicitly configured actor across independent ingress leases", async () => {
    const home = await mkdtemp(join(tmpdir(), "ptools-http-daemon-"));
    const internalStateDirectory = join(home, "state");
    const config = await Schema.decodeUnknownPromise(UserPtoolsConfig)({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [fileURLToPath(import.meta.resolve("tsx/cli")), fixturePath],
        },
      },
    });
    const [firstPort, secondPort] = await Promise.all([freePort(), freePort()]);
    const shared = { internalStateDirectory, hostId: "shared-actor" };
    const first = await startEmbeddedNodeHost({
      ...shared,
      publicOrigin: `http://127.0.0.1:${firstPort}`,
    });
    const second = await startEmbeddedNodeHost({
      ...shared,
      publicOrigin: `http://127.0.0.1:${secondPort}`,
    });

    try {
      await expect(
        first.call({ operation: "configure", input: { config } }),
      ).resolves.toMatchObject({ result: { ok: true } });
      await expect(first.codeMode.call(searchRequest())).resolves.toMatchObject(
        {
          output: { actions: [{ toolId: "fixture.echo" }] },
        },
      );

      await first.close();
      await expect(
        second.codeMode.call(searchRequest()),
      ).resolves.toMatchObject({
        output: { actions: [{ toolId: "fixture.echo" }] },
      });
    } finally {
      await first.close();
      await second.close();
    }
  }, 30_000);
});

const searchRequest = () => ({
  operation: "search" as const,
  input: CodeModeSearchRequest.make({
    query: "echo",
    provider: Option.none(),
    limit: Option.none(),
  }),
});

/** Bind port 0 briefly to learn a free loopback port, then close the listener. */
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
