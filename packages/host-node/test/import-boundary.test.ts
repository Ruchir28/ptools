import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const actorDaemonRoot = join(packageRoot, "src", "hostActorDaemon");

describe("host-node actor-daemon import boundaries", () => {
  it("separates actor, ownership, lease, RPC, and process lifecycles", async () => {
    await expect(fileExists(actorDaemonRoot)).resolves.toBe(true);
    for (const folder of [
      "actorRuntime",
      "ownership",
      "leases",
      "rpc",
      "daemonProcess",
    ]) {
      await expect(fileExists(join(actorDaemonRoot, folder))).resolves.toBe(
        true,
      );
    }
    await expect(
      fileExists(
        join(
          actorDaemonRoot,
          "actorRuntime",
          "contracts",
          "nodeHostActorRuntimeOptions.ts",
        ),
      ),
    ).resolves.toBe(true);
    await expect(
      fileExists(
        join(
          actorDaemonRoot,
          "daemonProcess",
          "nodeHostActorDaemonEntrypoint.ts",
        ),
      ),
    ).resolves.toBe(true);
    await expect(fileExists(join(packageRoot, "src", "daemon"))).resolves.toBe(
      false,
    );
  });

  it("exports only deployment clients and approved Node capabilities", async () => {
    const rootIndex = await readFile(
      join(packageRoot, "src", "index.ts"),
      "utf8",
    );
    const publicSources = await Promise.all(
      ["index.ts", "codeMode.ts"].map((file) =>
        readFile(join(packageRoot, "src", file), "utf8"),
      ),
    );
    const contents = publicSources.join("\n");

    expect(contents).not.toContain("hostActorDaemon");
    expect(contents).not.toContain("NodeHostRuntimeManager");
    expect(contents).not.toContain("NodeHostActorRuntime");
    for (const removed of [
      "NodeCodeModeRuntimeLive",
      "NodeCodeModeRuntimeLiveForHost",
      "NodeCodeModeServerLive",
      "NodeResolvedPtoolsConfigSourceLive",
      "FileResolvedPtoolsConfigSourceLive",
      "NodeConfigDiscoveryContext",
      "NodeAuthOptions",
    ]) {
      expect(contents).not.toContain(removed);
    }
    expect(contents).toContain("connectLocalNodeHost");
    expect(contents).not.toContain("openLocalNodeHost");
    expect(contents).toContain("createNodeCodeModeClient");
    expect(contents).not.toContain("startEmbeddedNodeHost");
    expect(contents).not.toContain("NodeEmbeddedHostHttpStackLive");
    expect(contents).not.toContain("NodeHostHttpServerLive");
  });

  it("deletes superseded embedded and automatic control-plane lifecycle modules", async () => {
    for (const path of [
      "auth.ts",
      "config.ts",
      "codeModeRuntime.ts",
      "hostHttp.ts",
      "layers/auth",
      "layers/codeModeRuntime.ts",
      "layers/platform/configDiscoveryContext.ts",
      "layers/platform/hostSettings.ts",
      "layers/platform/nodePlatform.ts",
      "hostControlPlaneDaemon/lifecycle",
      "hostControlPlaneDaemon/http/nodeHostControlPlaneHealth.ts",
      "services/nodeHostControlPlaneSpawner.ts",
      "services/nodeLocalDeploymentLeaseClient.ts",
    ]) {
      await expect(fileExists(join(packageRoot, "src", path))).resolves.toBe(
        false,
      );
    }
  });

  it("exports both package-owned daemon entry artifacts", async () => {
    const packageJson = JSON.parse(
      await readFile(join(packageRoot, "package.json"), "utf8"),
    ) as { readonly exports?: Record<string, unknown> };

    expect(packageJson.exports).toHaveProperty(
      "./host-actor-daemon-entrypoint",
    );
    expect(packageJson.exports).toHaveProperty(
      "./host-control-plane-daemon-entrypoint",
    );
    expect(packageJson.exports).not.toHaveProperty("./hostActorDaemon");
  });

  it("keeps actor runtime construction free of legacy config discovery", async () => {
    const sources = await Promise.all(
      [
        "daemonProcess/nodeHostActorStateNamespace.ts",
        "actorRuntime/nodeHostActorRuntime.ts",
        "actorRuntime/services/nodeHostRuntimeManager.ts",
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
        "actorRuntime/services/nodeDaemonHostActorRuntimeActivator.ts",
        "actorRuntime/services/nodeHostRuntimeManager.ts",
        "leases/services/nodeHostActorDaemonLeaseManager.ts",
      ].map((file) => readFile(join(actorDaemonRoot, file), "utf8")),
    );
    const contents = services.join("\n");

    expect(contents).toContain("extends Context.Service");
    expect(contents).not.toContain("extends Context.Tag");
  });

  // Control-plane HTTP should only discover/proxy to the actor daemon, not
  // embed actor runtime, MCP connector, Code Mode server, or the old
  // in-process dispatcher.
  it("keeps control-plane HTTP assembly free of actor/runtime platform layers", async () => {
    const contents = await readFile(
      join(
        packageRoot,
        "src/hostControlPlaneDaemon/http/nodeHostControlPlaneHttp.ts",
      ),
      "utf8",
    );

    for (const forbidden of [
      "NodeHostRuntimeManager",
      "HostStableRuntimeLayer",
      "HostInstanceHandler",
      "ConfiguredHostContextRunner",
      "NodeMcpConnectorLive",
      "DenoSandboxRuntimeLayer",
      "CodeModeServer",
      "AuthCoordinator",
      "NodeHostOperationDispatcher",
    ]) {
      expect(contents).not.toContain(forbidden);
    }
    expect(contents).toContain("NodeDaemonHostInstanceDiscoveryLive");
    expect(contents).not.toContain("HttpRouter.add");
    expect(contents).not.toContain("readFile");
    expect(contents).not.toContain("PTOOLS_CONFIG");
    expect(contents).not.toContain("process.env");
  });

  // Guard against regressing to the pre-daemon in-process HostOperationDispatcher.
  it("removes the legacy in-process dispatcher path", async () => {
    await expect(
      fileExists(join(packageRoot, "src", "hostOperationDispatcher.ts")),
    ).resolves.toBe(false);
    await expect(
      fileExists(
        join(packageRoot, "src", "layers", "hostOperationDispatcher.ts"),
      ),
    ).resolves.toBe(false);
  });

  it("keeps operation interpretation out of the runtime manager", async () => {
    const manager = await readFile(
      join(
        actorDaemonRoot,
        "actorRuntime",
        "services",
        "nodeHostRuntimeManager.ts",
      ),
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
