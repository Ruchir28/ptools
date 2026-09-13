/*
 * The Control Center owns browser navigation and presentation; the Host backend
 * remains a Principal-authenticated JSON API.
 *
 * What this proves:
 * 1. Shared routing renders the login component supplied by the platform.
 * 2. Human URL query values stay in React route state and never enter API URLs.
 * 3. All auth statuses render with authoritative actions and no HTML forms.
 * 4. Browser mutations send JSON and only navigate to validated HTTP(S) URLs.
 *
 * React's server renderer and React Router's memory history are real. Fetch and
 * final browser navigation are the only fakes because this suite stops at the
 * shared browser/platform boundary.
 */
import type { McpAuthStatus } from "@ptools/auth/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import {
  AuthCenterStatusView,
  ControlCenterApp,
} from "../src/ControlCenterApp.js";
import {
  ControlCenterApiError,
  makeBrowserHostApiClient,
} from "../src/browserHostApiClient.js";
import { parseAuthCenterQuery } from "../src/authCenterQuery.js";
import type { ControlCenterBrowserAuthentication } from "../src/browserAuthenticationIntegration.js";

const authenticatedBrowserIntegration: ControlCenterBrowserAuthentication = {
  useAuthentication: () => ({ _tag: "Authenticated" }),
  LoginPage: () => <p>Test login page</p>,
};

const status: McpAuthStatus = {
  authUrl: "https://ptools.example/hosts/team%20host/auth",
  servers: [
    authServer("connected", "connected"),
    authServer("requires", "requires_auth"),
    authServer("progress", "auth_in_progress"),
    authServer("failed", "auth_failed", "provider said <retry>"),
    authServer("setup<script>", "needs_config", "configure <client>"),
    authServer("static", "static_credentials"),
    authServer("unsupported", "unsupported_auth"),
    authServer("disabled", "disabled"),
  ],
};

describe("Control Center routing", () => {
  it("matches and decodes the Auth Center route through React Router", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/hosts/team%20host/auth"]}>
        <ControlCenterApp authentication={authenticatedBrowserIntegration} />
      </MemoryRouter>,
    );

    expect(html).toContain('<p class="host-id">team host</p>');
    expect(html).toContain("Loading authentication status");
    expect(html).not.toContain("Page not found");
  });

  it("renders the platform login page with a safe internal return location", () => {
    const authentication: ControlCenterBrowserAuthentication = {
      useAuthentication: () => ({ _tag: "Unauthenticated" }),
      LoginPage: ({ returnTo }) => <p>Node login for {returnTo}</p>,
    };
    const html = renderToStaticMarkup(
      <MemoryRouter
        initialEntries={[
          "/login?returnTo=%2Fhosts%2Fhost-1%2Fauth%3Fserver%3Dgithub",
        ]}
      >
        <ControlCenterApp authentication={authentication} />
      </MemoryRouter>,
    );

    expect(html).toContain("Node login for /hosts/host-1/auth?server=github");

    const unsafeHtml = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/login?returnTo=%2F%2Fevil.example"]}>
        <ControlCenterApp authentication={authentication} />
      </MemoryRouter>,
    );
    expect(unsafeHtml).toContain("Node login for /");
    expect(unsafeHtml).not.toContain("evil.example");
  });

  it("decodes presentation selection without putting it in the route path", () => {
    const url = new URL(
      "https://ptools.example/hosts/host-1/auth?server=github%20enterprise&intent=reauthorize",
    );

    expect(parseAuthCenterQuery(url.searchParams)).toEqual({
      selection: {
        serverName: "github enterprise",
        intent: "reauthorize",
      },
    });
  });

  it("retains the page but reports malformed presentation selection safely", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter
        initialEntries={[
          "/hosts/host-1/auth?server=github&intent=force",
        ]}
      >
        <ControlCenterApp authentication={authenticatedBrowserIntegration} />
      </MemoryRouter>,
    );

    expect(html).toContain('<p class="host-id">host-1</p>');
    expect(html).toContain("The selected server link is malformed.");
    expect(html).not.toContain("Page not found");
  });
});

describe("Auth Center React status view", () => {
  it("renders every status with four button actions and no HTML forms", () => {
    const html = renderToStaticMarkup(
      <AuthCenterStatusView status={status} onStart={() => undefined} />,
    );

    expect(html.match(/<button/g)).toHaveLength(4);
    expect(html).toContain("Reconnect");
    expect(html).toContain("Connect");
    expect(html).toContain("Continue authorization");
    expect(html).toContain("Retry authorization");
    expect(html).toContain("auth.clientId");
    expect(html).toContain("auth.clientSecret");
    expect(html).toContain("Static credentials are configured");
    expect(html).toContain("does not support a browser authentication flow");
    expect(html).toContain("This MCP server is disabled");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<script>");
    expect(html).toContain("setup&lt;script&gt;");
    expect(html).toContain("configure &lt;client&gt;");
  });

  it("uses current status rather than stale setup intent for its action", () => {
    const html = renderToStaticMarkup(
      <AuthCenterStatusView
        status={{ ...status, servers: [authServer("github", "connected")] }}
        selection={{ serverName: "github", intent: "setup" }}
        onStart={() => undefined}
      />,
    );

    expect(html).toContain("Configure: <strong>github</strong>");
    expect(html).toContain(">Reconnect</button>");
    expect(html).not.toContain("manual OAuth client configuration");
  });
});

describe("Control Center browser Host API client", () => {
  it("keeps selection out of the GET API and sends start intent as JSON", async () => {
    const requests: Array<Request> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const request = new Request(
        new URL(String(input), "http://localhost"),
        init,
      );
      requests.push(request);
      if (request.method === "GET") {
        return Response.json({
          operation: "mcp_auth_status",
          result: { ok: true, status },
        });
      }
      return Response.json({
        operation: "start_mcp_auth",
        result: {
          ok: true,
          authorizeUrl: "https://provider.example/oauth/authorize",
        },
      });
    };
    const client = makeBrowserHostApiClient(fakeFetch);

    await client.getMcpAuthStatus("team host");
    const authorizeUrl = await client.startMcpAuth(
      "team host",
      "github enterprise",
      true,
    );

    expect(requests[0]!.url).toBe(
      "http://localhost/api/browser/hosts/team%20host/mcp-auth",
    );
    expect(requests[0]!.url).not.toContain("intent");
    expect(requests[1]!.headers.get("content-type")).toBe("application/json");
    expect(await requests[1]!.json()).toEqual({ force: true });
    expect(authorizeUrl.toString()).toBe(
      "https://provider.example/oauth/authorize",
    );
  });

  it("fails closed on non-HTTP provider navigation", async () => {
    const client = makeBrowserHostApiClient(async () =>
      Response.json({
        operation: "start_mcp_auth",
        result: { ok: true, authorizeUrl: "javascript:alert(1)" },
      }),
    );

    await expect(
      client.startMcpAuth("host-1", "github", false),
    ).rejects.toBeInstanceOf(ControlCenterApiError);
  });
});

function authServer(
  serverName: string,
  authStatus: McpAuthStatus["servers"][number]["status"],
  message?: string,
): McpAuthStatus["servers"][number] {
  return {
    serverName,
    jsServerName: serverName.replace(/\W/g, "_"),
    transport: "http",
    status: authStatus,
    ...(message === undefined ? {} : { message }),
  };
}
