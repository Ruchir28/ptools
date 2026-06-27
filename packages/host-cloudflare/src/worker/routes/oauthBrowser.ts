/**
 * Browser-specific MCP auth routes.
 *
 * Host-owned auth work is dispatched through the Cloudflare HostServer. This
 * file only adapts browser HTTP routes whose carrier response is not JSON
 * host-api transport: OAuth setup guidance and provider callback responses.
 */
import type { McpAuthStatus } from "@ptools/auth/contracts";
import {
  isHostApiProtocolFailureResponse,
  type CompleteHostMcpOAuthCallbackResponse,
  type HostApiResponse,
  type StartHostMcpAuthResponse,
} from "@ptools/host-api";
import * as Effect from "effect/Effect";
import { Hono } from "hono";
import {
  HostCloudflareError,
  codeModeUnavailable,
  methodNotAllowed,
  notFound,
} from "../../errors.js";
import {
  errorResponse,
  runJsonWorkerRoute,
  runWorkerRoute,
  type CloudflareWorkerHonoEnv,
} from "../http.js";
import { dispatchCloudflareHostApiRequest } from "../hostApiHttpAdapter.js";
import {
  readMcpOAuthCallbackBody,
  requestOrigin,
  requirePublicWorkerAuth,
} from "../request.js";

export const oauthBrowserRoutes = new Hono<CloudflareWorkerHonoEnv>()
  .get("/hosts/:hostId/auth/:serverName/setup", (context) =>
    runJsonWorkerRoute(
      handleMcpAuthSetupRoute({
        request: context.req.raw,
        hostId: context.req.param("hostId"),
        serverName: context.req.param("serverName"),
        env: context.env,
      }),
    ),
  )
  .all("/hosts/:hostId/auth/:serverName/setup", () =>
    errorResponse(methodNotAllowed(["GET"])),
  )
  .get("/hosts/:hostId/auth/:serverName", (context) =>
    runWorkerRoute(
      handleMcpAuthStartRoute({
        request: context.req.raw,
        hostId: context.req.param("hostId"),
        serverName: context.req.param("serverName"),
        env: context.env,
      }),
      (authorizeUrl) => Response.redirect(authorizeUrl, 302),
    ),
  )
  .all("/hosts/:hostId/auth/:serverName", () =>
    errorResponse(methodNotAllowed(["GET", "POST"])),
  )
  .get("/hosts/:hostId/oauth/callback/:provider", (context) =>
    runWorkerRoute(
      handleMcpOAuthCallbackRoute({
        request: context.req.raw,
        hostId: context.req.param("hostId"),
        provider: context.req.param("provider"),
        env: context.env,
      }),
      (response) => response,
    ),
  )
  .post("/hosts/:hostId/oauth/callback/:provider", (context) =>
    runWorkerRoute(
      handleMcpOAuthCallbackRoute({
        request: context.req.raw,
        hostId: context.req.param("hostId"),
        provider: context.req.param("provider"),
        env: context.env,
      }),
      (response) => response,
    ),
  )
  .all("/hosts/:hostId/oauth/callback/:provider", () =>
    errorResponse(methodNotAllowed(["GET", "POST"])),
  );

const handleMcpAuthSetupRoute = (
  input: McpAuthRouteInput & { readonly serverName: string },
) =>
  Effect.gen(function* () {
    yield* requirePublicWorkerAuth(input);

    const origin = requestOrigin(input.request);
    const hostResponse = yield* dispatchCloudflareHostApiRequest({
      namespace: input.env.PTOOLS_CODE_MODE,
      hostId: input.hostId,
      origin,
      request: { operation: "mcp_auth_status", input: { origin } },
    });
    const status = yield* extractMcpAuthStatus(hostResponse);
    const server = status.servers.find(
      (candidate) => candidate.serverName === input.serverName,
    );

    if (server === undefined) {
      return yield* notFound();
    }

    return {
      serverName: input.serverName,
      status: server.status,
      ...(server.message === undefined ? {} : { message: server.message }),
      config: {
        method: "PUT" as const,
        url: `${origin}/hosts/${encodeURIComponent(input.hostId)}/config`,
        contentType: "application/json" as const,
        authObject: {
          root: "mcpServers" as const,
          serverName: input.serverName,
          field: "auth" as const,
        },
        fields: ["clientId", "clientSecret"] as const,
        // `/config` is now a host-api route, so setup guidance must show the
        // HostApiRequest envelope rather than the old raw ptools config body.
        // `input.config` is still a complete host config replacement, not a
        // patch; callers should merge these auth fields into their full config.
        bodyTemplate: {
          operation: "configure" as const,
          input: {
            config: {
              mcpServers: {
                [input.serverName]: {
                  url: "<existing MCP server URL>",
                  auth: {
                    type: "oauth" as const,
                    clientId: "<clientId>",
                    clientSecret: "<clientSecret>",
                  },
                },
              },
            },
          },
        },
        note: "PUT a HostApiRequest envelope. input.config must be the complete host config after adding the OAuth client credentials.",
      },
    };
  });

/**
 * Browser/workflow route backing the authorizeUrl/reauthorizeUrl values exposed
 * in MCP auth status. The machine API also supports `start_mcp_auth` over POST,
 * but a clickable status link must remain a GET route that redirects the user
 * to the provider authorization URL.
 */
const handleMcpAuthStartRoute = (
  input: McpAuthRouteInput & { readonly serverName: string },
): Effect.Effect<string, HostCloudflareError> =>
  Effect.gen(function* () {
    yield* requirePublicWorkerAuth(input);

    const origin = requestOrigin(input.request);
    const force = isForceAuthRequest(input.request);
    const hostResponse = yield* dispatchCloudflareHostApiRequest({
      namespace: input.env.PTOOLS_CODE_MODE,
      hostId: input.hostId,
      origin,
      request: {
        operation: "start_mcp_auth",
        input: {
          origin,
          serverName: input.serverName,
          ...(force ? { force } : {}),
        },
      },
    });

    return yield* authorizeUrlFromHostApiResponse(hostResponse);
  });

const handleMcpOAuthCallbackRoute = (
  input: McpAuthRouteInput & { readonly provider: string },
): Effect.Effect<Response, HostCloudflareError> =>
  Effect.gen(function* () {
    const bodyText =
      input.request.method === "POST"
        ? yield* readMcpOAuthCallbackBody(input.request)
        : undefined;
    const origin = requestOrigin(input.request);
    const hostResponse = yield* dispatchCloudflareHostApiRequest({
      namespace: input.env.PTOOLS_CODE_MODE,
      hostId: input.hostId,
      origin,
      request: {
        operation: "complete_mcp_oauth_callback",
        input: {
          origin,
          provider: input.provider,
          method: input.request.method,
          url: input.request.url,
          ...(bodyText === undefined ? {} : { bodyText }),
        },
      },
    });

    return yield* oauthCallbackResponseFromHostApiResponse(hostResponse);
  });

const extractMcpAuthStatus = (
  response: HostApiResponse,
): Effect.Effect<McpAuthStatus, HostCloudflareError> => {
  if (isHostApiProtocolFailureResponse(response)) {
    return Effect.fail(hostApiProtocolFailureToCloudflareError(response.error));
  }

  if (response.operation !== "mcp_auth_status") {
    return Effect.fail(
      codeModeUnavailable({
        message: `Unexpected host-api response ${response.operation}.`,
      }),
    );
  }

  if (!response.result.ok) {
    return Effect.fail(
      hostMcpAuthErrorToCloudflareError(response.result.error),
    );
  }

  return Effect.succeed(response.result.status);
};

const authorizeUrlFromHostApiResponse = (
  response: HostApiResponse,
): Effect.Effect<
  Extract<
    StartHostMcpAuthResponse["result"],
    { readonly ok: true }
  >["authorizeUrl"],
  HostCloudflareError
> => {
  if (isHostApiProtocolFailureResponse(response)) {
    return Effect.fail(hostApiProtocolFailureToCloudflareError(response.error));
  }

  if (response.operation !== "start_mcp_auth") {
    return Effect.fail(
      codeModeUnavailable({
        message: `Unexpected host-api response ${response.operation}.`,
      }),
    );
  }

  if (!response.result.ok) {
    return Effect.fail(
      hostMcpAuthErrorToCloudflareError(response.result.error),
    );
  }

  return Effect.succeed(response.result.authorizeUrl);
};

const oauthCallbackResponseFromHostApiResponse = (
  response: HostApiResponse,
): Effect.Effect<Response, HostCloudflareError> => {
  if (isHostApiProtocolFailureResponse(response)) {
    return Effect.fail(hostApiProtocolFailureToCloudflareError(response.error));
  }

  if (response.operation !== "complete_mcp_oauth_callback") {
    return Effect.fail(
      codeModeUnavailable({
        message: `Unexpected host-api response ${response.operation}.`,
      }),
    );
  }

  if (!response.result.ok) {
    return Effect.fail(
      hostMcpAuthErrorToCloudflareError(response.result.error),
    );
  }

  return Effect.succeed(mcpOAuthCallbackResponse(response.result.response));
};

const mcpOAuthCallbackResponse = (
  response: Extract<
    CompleteHostMcpOAuthCallbackResponse["result"],
    { readonly ok: true }
  >["response"],
): Response =>
  new Response(response.body, {
    status: response.status,
    ...(response.headers === undefined ? {} : { headers: response.headers }),
  });

const hostMcpAuthErrorToCloudflareError = (error: {
  readonly code:
    | "invalid_config"
    | "auth_unavailable"
    | "invalid_oauth_callback"
    | "oauth_failed";
  readonly message: string;
}): HostCloudflareError => {
  switch (error.code) {
    case "invalid_config":
      return new HostCloudflareError({
        code: "invalid_config",
        status: 400,
        message: error.message,
      });
    case "invalid_oauth_callback":
      return new HostCloudflareError({
        code: "invalid_oauth_callback",
        status: 400,
        message: error.message,
      });
    case "auth_unavailable":
    case "oauth_failed":
      return codeModeUnavailable(error);
  }
};

const hostApiProtocolFailureToCloudflareError = (error: {
  readonly code:
    | "invalid_host_api_request"
    | "unauthorized"
    | "unknown_operation"
    | "host_unavailable";
  readonly message: string;
}): HostCloudflareError => {
  switch (error.code) {
    case "invalid_host_api_request":
    case "unknown_operation":
      return new HostCloudflareError({
        code: "invalid_oauth_callback",
        status: 400,
        message: error.message,
      });
    case "unauthorized":
      return new HostCloudflareError({
        code: "unauthorized",
        status: 401,
        message: error.message,
        headers: { "WWW-Authenticate": "Bearer" },
      });
    case "host_unavailable":
      return codeModeUnavailable(error);
  }
};

const isForceAuthRequest = (request: Request): boolean => {
  const force = new URL(request.url).searchParams.get("force");

  return force === "1" || force === "true";
};

interface McpAuthRouteInput {
  readonly request: Request;
  readonly hostId: string;
  readonly env: CloudflareWorkerHonoEnv["Bindings"];
}
