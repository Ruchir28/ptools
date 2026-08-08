/**
 * Named deployment catalog coverage.
 *
 * Mental model:
 *   Before a caller knows a deployment's custom state directory, its stable
 *   name resolves through `<PTOOLS_HOME>/node-deployments/<name>/deployment.json`.
 *   That descriptor contains fixed infrastructure only: port, complete state
 *   root, and optional executable override. It does not claim that a process is
 *   ready, and reading it never starts a daemon.
 *
 * What this proves:
 *   1. First use of `default` creates exactly the conventional descriptor and
 *      does not adopt an older state-directory convention.
 *   2. Custom deployments require explicit creation, canonical names, absolute
 *      state paths, and one unique state/lock authority per deployment.
 *   3. Catalog listing and lookup schema-decode persisted data and fail closed
 *      rather than replacing malformed infrastructure.
 *   4. Configuration probes real daemon ownership and cannot rewrite a
 *      descriptor while deployment state is active.
 *
 * Boundaries:
 *   Temporary directories, descriptor files, atomic catalog writes, and native
 *   kernel locks are real. The malformed descriptor is deliberately written by
 *   the test to represent disk corruption. No daemon, network listener, storage
 *   API, lock implementation, or schema decoder is mocked or faked.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configureNodeLocalDeployment,
  createNodeLocalDeployment,
  listNodeLocalDeployments,
  resolveNodeLocalDeployment,
} from "../src/localDeployments/nodeLocalDeploymentCatalog.js";
import {
  acquireNodeHostControlPlaneOwnership,
  assertNodeDeploymentStateQuiescent,
} from "../src/hostControlPlaneDaemon/ownership/nodeHostControlPlaneOwnership.js";

let previousHome: string | undefined;
let home: string;

describe("named local Node deployment catalog", { concurrent: false }, () => {
  beforeEach(async () => {
    // PTOOLS_HOME is process-global, so every test gets a private catalog and
    // suite concurrency stays disabled to prevent one case from changing
    // another's root.
    previousHome = process.env.PTOOLS_HOME;
    home = await mkdtemp(join(tmpdir(), "ptools-deployments-"));
    process.env.PTOOLS_HOME = home;
  });

  afterEach(async () => {
    // Restore caller state and remove every real descriptor and lock created by
    // the test.
    if (previousHome === undefined) delete process.env.PTOOLS_HOME;
    else process.env.PTOOLS_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });

  /**
   * First-use provisioning is reserved for the conventional default deployment
   * and must create its current isolated state root, not revive a legacy path.
   */
  it("creates the exact default descriptor without adopting the old state path", async () => {
    // Start-only resolution may provision the missing conventional default;
    // ordinary connect-only resolution is not allowed to perform this mutation.
    const descriptor = await Effect.runPromise(
      resolveNodeLocalDeployment("default", { createDefaultIfMissing: true }),
    );

    expect(descriptor.controlPlanePort).toBe(19_876);
    expect(descriptor.stateDirectory).toBe(
      join(home, "node-deployments", "default", "state"),
    );
    expect(descriptor.stateDirectory).not.toBe(join(home, "state"));
    // Inspect the actual wire representation so the test covers persistence,
    // not only the already-decoded value returned by the create operation.
    const disk = JSON.parse(
      await readFile(
        join(home, "node-deployments", "default", "deployment.json"),
        "utf8",
      ),
    );
    expect(disk).toMatchObject({
      version: 1,
      name: "default",
      controlPlanePort: 19_876,
    });
  });

  /**
   * Custom infrastructure is opt-in, and each deployment needs its own absolute
   * state root so names cannot accidentally share locks or persisted state.
   */
  it("requires explicit custom creation and rejects duplicate state aliases", async () => {
    // Lookup is intentionally connect-only for custom names: it gives explicit
    // creation guidance instead of silently provisioning infrastructure.
    await expect(
      Effect.runPromise(resolveNodeLocalDeployment("work")),
    ).rejects.toThrow("ptools node deployment create");
    const sharedState = join(home, "shared-state");
    await Effect.runPromise(
      createNodeLocalDeployment({
        name: "work",
        port: 20_001,
        stateDirectory: sharedState,
      }),
    );
    // Two names cannot alias one state directory because that would collapse
    // their native locks and databases into the same authority.
    await expect(
      Effect.runPromise(
        createNodeLocalDeployment({
          name: "other",
          port: 20_002,
          stateDirectory: sharedState,
        }),
      ),
    ).rejects.toThrow("already owned");
    // These are ingress validation checks: unsafe names never enter path
    // construction, and relative paths never become persisted lock roots.
    await expect(
      Effect.runPromise(
        createNodeLocalDeployment({ name: "Bad Name", port: 20_003 }),
      ),
    ).rejects.toThrow("Invalid local Node deployment name");
    await expect(
      Effect.runPromise(
        createNodeLocalDeployment({
          name: "relative",
          port: 20_004,
          stateDirectory: "relative/path",
        }),
      ),
    ).rejects.toThrow("must be absolute");
  });

  /**
   * Reconfiguration must not race a running deployment: ownership is checked
   * before replacing the descriptor, preserving the active endpoint on disk.
   */
  it("rejects configuration while deployment state is actively owned", async () => {
    const descriptor = await Effect.runPromise(
      createNodeLocalDeployment({ name: "active", port: 20_020 }),
    );

    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // Hold the same native control-plane lock as a real starting/running
          // daemon while configure probes both deployment lock domains.
          yield* acquireNodeHostControlPlaneOwnership(
            descriptor.stateDirectory,
          );
          return yield* configureNodeLocalDeployment(
            descriptor.name,
            { port: 20_021 },
            (current) =>
              assertNodeDeploymentStateQuiescent(current.stateDirectory),
          ).pipe(Effect.exit);
        }),
      ),
    );

    expect(exit._tag).toBe("Failure");
    // Re-read from disk to prove failure occurred before the atomic descriptor
    // replacement rather than merely returning an error after mutation.
    expect(
      (await Effect.runPromise(resolveNodeLocalDeployment(descriptor.name)))
        .controlPlanePort,
    ).toBe(20_020);
  });

  /**
   * The catalog treats disk data as an untrusted persistence boundary: listing
   * returns valid descriptors only, while corruption fails instead of reset.
   */
  it("lists validated descriptors and refuses to replace a malformed default", async () => {
    await Effect.runPromise(
      createNodeLocalDeployment({ name: "work", port: 20_010 }),
    );
    // Listing is discovery of schema-valid descriptors, not process readiness.
    expect(
      (await Effect.runPromise(listNodeLocalDeployments())).map(
        (item) => item.name,
      ),
    ).toEqual(["work"]);

    // Write an unsupported descriptor version directly to simulate corruption
    // at the external disk boundary. Default resolution must not overwrite it.
    const directory = join(home, "node-deployments", "default");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "deployment.json"), '{"version":2}\n');
    await expect(
      Effect.runPromise(
        resolveNodeLocalDeployment("default", { createDefaultIfMissing: true }),
      ),
    ).rejects.toThrow("Unable to read");
  });
});
