/**
 * End-to-end coverage: public Host/Code Mode HTTP clients → shared actor daemon.
 *
 * Background — each embedded client owns a public HTTP listener and one daemon
 * connection lease. Clients using the same PTOOLS_HOME discover the same daemon
 * process, while the shared hostId selects the same authoritative actor inside
 * it. Closing one client must release only its own listener/lease, not actor
 * ownership that another live client still depends on.
 *
 * What this proves:
 *   1. Two independently started public HTTP servers (different ports/leases)
 *      can both reach the same daemon-backed actor (same hostId + PTOOLS_HOME).
 *   2. Closing the first client's lease does not take down the daemon while the
 *      second client still holds a lease — second.call still succeeds afterward.
 *
 * Requires Deno (sandbox executor). Spawns real detached daemons via the normal
 * client/startup path; this is slower than the in-process lifecycle test.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodeModeSearchRequest } from "@ptools/code-mode-api";
import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { createNodeCodeModeClient } from "../src/clientHandles.js";

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
  it("keeps one daemon actor reachable through two independently leased HTTP servers", async () => {
    // Isolated PTOOLS_HOME + config so this run does not collide with other
    // local daemons or developer state.
    const home = await mkdtemp(join(tmpdir(), "ptools-http-daemon-"));
    const configPath = join(home, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          fixture: {
            command: process.execPath,
            args: [fileURLToPath(import.meta.resolve("tsx/cli")), fixturePath],
          },
        },
      }),
    );

    // Two public origins → two HTTP server instances/leases; same hostId so
    // both discovery paths target one shared daemon actor.
    const [firstPort, secondPort] = await Promise.all([freePort(), freePort()]);
    const shared = {
      env: { PTOOLS_HOME: home },
      hostId: "shared-actor",
    };
    const first = await createNodeCodeModeClient(configPath, {
      ...shared,
      publicOrigin: `http://127.0.0.1:${firstPort}`,
    });
    const second = await createNodeCodeModeClient(configPath, {
      ...shared,
      publicOrigin: `http://127.0.0.1:${secondPort}`,
    });

    try {
      // First lease can drive a real code-mode search through the daemon.
      await expect(first.call(searchRequest())).resolves.toMatchObject({
        output: { actions: [{ toolId: "fixture.echo" }] },
      });
      // Releasing the first lease must leave the daemon up for the second lease.
      await first.close();
      await expect(second.call(searchRequest())).resolves.toMatchObject({
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
