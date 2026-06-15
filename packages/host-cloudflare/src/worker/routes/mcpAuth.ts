import * as Effect from "effect/Effect";
import { Hono } from "hono";
import {
  methodNotAllowed,
  notFound,
  type HostCloudflareError,
} from "../../errors.js";
import type { CompleteMcpOAuthCallbackResult } from "../../objects/codeModeObject/rpc.js";
import {
  callCodeModeObjectCompleteMcpOAuthCallback,
  callCodeModeObjectMcpAuthStatus,
  callCodeModeObjectStartMcpAuth,
} from "../codeModeObjectRpc.js";
import {
  errorResponse,
  runJsonWorkerRoute,
  runWorkerRoute,
  type CloudflareWorkerHonoEnv,
} from "../http.js";
import {
  readMcpOAuthCallbackBody,
  requestOrigin,
  requirePublicWorkerAuth,
} from "../request.js";

export const mcpAuthRoutes = new Hono<CloudflareWorkerHonoEnv>()
  .get("/hosts/:hostId/auth/status", (context) =>
    runJsonWorkerRoute(
      handleMcpAuthStatusRoute({
        request: context.req.raw,
        hostId: context.req.param("hostId"),
        env: context.env,
      }),
    ),
  )
  .all("/hosts/:hostId/auth/status", () =>
    errorResponse(methodNotAllowed(["GET"])),
  )
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
    runJsonWorkerRoute(
      handleMcpAuthStartRoute({
        request: context.req.raw,
        hostId: context.req.param("hostId"),
        serverName: context.req.param("serverName"),
        env: context.env,
      }),
    ),
  )
  .all("/hosts/:hostId/auth/:serverName", () =>
    errorResponse(methodNotAllowed(["GET"])),
  )
  .get("/hosts/:hostId/oauth/callback/:provider", (context) =>
    runWorkerRoute(
      handleMcpOAuthCallbackRoute({
        request: context.req.raw,
        hostId: context.req.param("hostId"),
        provider: context.req.param("provider"),
        env: context.env,
      }),
      mcpOAuthCallbackResponse,
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
      mcpOAuthCallbackResponse,
    ),
  )
  .all("/hosts/:hostId/oauth/callback/:provider", () =>
    errorResponse(methodNotAllowed(["GET", "POST"])),
  );

const handleMcpAuthStatusRoute = (input: McpAuthRouteInput) =>
  Effect.gen(function* () {
    yield* requirePublicWorkerAuth(input);

    return yield* callCodeModeObjectMcpAuthStatus({
      namespace: input.env.PTOOLS_CODE_MODE,
      hostId: input.hostId,
      origin: requestOrigin(input.request),
    });
  });

const handleMcpAuthStartRoute = (
  input: McpAuthRouteInput & { readonly serverName: string },
) =>
  Effect.gen(function* () {
    yield* requirePublicWorkerAuth(input);

    // `force` belongs only to this route. Accept the generated `?force=1`
    // reauthorization URL and the explicit boolean spelling `?force=true`.
    const forceValue = new URL(input.request.url).searchParams.get("force");

    return yield* callCodeModeObjectStartMcpAuth({
      namespace: input.env.PTOOLS_CODE_MODE,
      hostId: input.hostId,
      origin: requestOrigin(input.request),
      serverName: input.serverName,
      force: forceValue === "1" || forceValue === "true",
    });
  });

const handleMcpAuthSetupRoute = (
  input: McpAuthRouteInput & { readonly serverName: string },
) =>
  Effect.gen(function* () {
    yield* requirePublicWorkerAuth(input);

    const origin = requestOrigin(input.request);
    const status = yield* callCodeModeObjectMcpAuthStatus({
      namespace: input.env.PTOOLS_CODE_MODE,
      hostId: input.hostId,
      origin,
    });
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
        authObject: {
          root: "mcpServers" as const,
          serverName: input.serverName,
          field: "auth" as const,
        },
        fields: ["clientId", "clientSecret"] as const,
        note: "Upload the complete host config after adding the OAuth client credentials.",
      },
    };
  });

const handleMcpOAuthCallbackRoute = (
  input: McpAuthRouteInput & { readonly provider: string },
): Effect.Effect<CompleteMcpOAuthCallbackResult, HostCloudflareError> =>
  Effect.gen(function* () {
    const bodyText =
      input.request.method === "POST"
        ? yield* readMcpOAuthCallbackBody(input.request)
        : undefined;

    return yield* callCodeModeObjectCompleteMcpOAuthCallback({
      namespace: input.env.PTOOLS_CODE_MODE,
      hostId: input.hostId,
      origin: requestOrigin(input.request),
      provider: input.provider,
      method: input.request.method,
      url: input.request.url,
      ...(bodyText === undefined ? {} : { bodyText }),
    });
  });

interface McpAuthRouteInput {
  readonly request: Request;
  readonly hostId: string;
  readonly env: CloudflareWorkerHonoEnv["Bindings"];
}

const mcpOAuthCallbackResponse = (
  result: CompleteMcpOAuthCallbackResult,
): Response =>
  new Response(result.body, {
    status: result.status,
    ...(result.headers === undefined ? {} : { headers: result.headers }),
  });
