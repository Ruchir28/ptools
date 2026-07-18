import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const actorDaemonRoot = join(packageRoot, "src", "hostActorDaemon");

describe("host-node actor-daemon import boundaries", () => {
  it("uses the ownership-revealing hostActorDaemon source folder", async () => {
    await expect(fileExists(actorDaemonRoot)).resolves.toBe(true);
    await expect(
      fileExists(
        join(actorDaemonRoot, "contracts", "nodeHostActorRuntimeOptions.ts"),
      ),
    ).resolves.toBe(true);
    await expect(
      fileExists(
        join(actorDaemonRoot, "layers", "nodeHostActorRuntimeLayer.ts"),
      ),
    ).resolves.toBe(true);
    await expect(
      fileExists(
        join(
          actorDaemonRoot,
          "services",
          "nodeDaemonHostActorRuntimeActivator.ts",
        ),
      ),
    ).resolves.toBe(true);
    await expect(
      fileExists(
        join(actorDaemonRoot, "services", "nodeHostRuntimeManager.ts"),
      ),
    ).resolves.toBe(true);
    await expect(fileExists(join(packageRoot, "src", "daemon"))).resolves.toBe(
      false,
    );
  });

  it("does not export daemon internals from the package root", async () => {
    const rootIndex = await readFile(
      join(packageRoot, "src", "index.ts"),
      "utf8",
    );

    expect(rootIndex).not.toContain("hostActorDaemon");
    expect(rootIndex).not.toContain("NodeHostRuntimeManager");
    expect(rootIndex).not.toContain("NodeHostActorRuntime");
  });

  it("keeps actor runtime construction free of legacy config discovery", async () => {
    const sources = await Promise.all(
      [
        "nodeHostActorStateNamespace.ts",
        "nodeHostActorRuntime.ts",
        "services/nodeHostRuntimeManager.ts",
      ].map((file) => readFile(join(actorDaemonRoot, file), "utf8")),
    );
    const contents = sources.join("\n");

    expect(contents).not.toContain("PTOOLS_CONFIG");
    expect(contents).not.toContain("ConfigDiscovery");
    expect(contents).not.toContain("process.cwd");
    expect(contents).not.toContain("NodeHostSettings");
    expect(contents).not.toContain("NodeHostOperationDispatcher");
  });

  it("uses Effect.Service for daemon-owned services without new Context.Tag layers", async () => {
    const services = await Promise.all(
      [
        "nodeDaemonHostActorRuntimeActivator.ts",
        "nodeHostRuntimeManager.ts",
      ].map((file) =>
        readFile(join(actorDaemonRoot, "services", file), "utf8"),
      ),
    );
    const contents = services.join("\n");

    expect(contents).toContain("extends Effect.Service");
    expect(contents).not.toContain("extends Context.Tag");
  });

  it("keeps operation interpretation out of the runtime manager", async () => {
    const manager = await readFile(
      join(actorDaemonRoot, "services", "nodeHostRuntimeManager.ts"),
      "utf8",
    );

    expect(manager).not.toContain("switch (");
    expect(manager).not.toContain('case "configure"');
    expect(manager).not.toContain('case "code_mode"');
    expect(manager).toContain("runtime.dispatch(input)");
  });
});

const fileExists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );
