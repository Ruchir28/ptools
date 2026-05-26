import { afterEach, describe, expect, it } from "vitest";
import { PtoolsAuthManager } from "../src/auth.js";

describe("PtoolsAuthManager", () => {
  let manager: PtoolsAuthManager | undefined;

  afterEach(async () => {
    await manager?.close();
    manager = undefined;
  });

  it("exposes a manual reauthorize URL for connected HTTP servers", async () => {
    manager = await PtoolsAuthManager.start();

    manager.noteConfigured("notion", "notion", {
      transport: "http",
      url: "https://mcp.notion.com/mcp",
    });

    const status = manager.status();

    expect(status.servers).toHaveLength(1);
    expect(status.servers[0]).toEqual(
      expect.objectContaining({
        serverName: "notion",
        status: "connected",
        reauthorizeUrl: expect.stringMatching(
          /^http:\/\/127\.0\.0\.1:\d+\/auth\/notion\?force=1$/,
        ),
      }),
    );
    expect(status.servers[0]?.authorizeUrl).toBeUndefined();
  });

  it("does not expose manual reauthorize for static credentials", async () => {
    manager = await PtoolsAuthManager.start();

    manager.noteConfigured("api", "api", {
      transport: "http",
      url: "https://example.com/mcp",
      headers: { authorization: "Bearer token" },
    });

    const status = manager.status();

    expect(status.servers).toHaveLength(1);
    expect(status.servers[0]).toEqual(
      expect.objectContaining({
        serverName: "api",
        status: "static_credentials",
      }),
    );
    expect(status.servers[0]?.reauthorizeUrl).toBeUndefined();
  });

  it("runs manual per-server refresh from the auth center", async () => {
    const refreshedServers: Array<string> = [];
    manager = await PtoolsAuthManager.start({
      onRefresh: async (serverName) => {
        refreshedServers.push(serverName);
      },
    });

    const response = await fetch(
      `${manager.authUrl.replace(/\/auth$/, "")}/refresh/notion`,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Refresh complete");
    expect(refreshedServers).toEqual(["notion"]);
  });
});
