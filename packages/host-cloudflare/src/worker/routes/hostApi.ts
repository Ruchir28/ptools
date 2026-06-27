/**
 * Host-api HTTP routes for Cloudflare Worker ingress.
 *
 * These routes own only HTTP concerns: bearer auth, JSON body parsing, optional
 * route-operation checks for old endpoint aliases, and response serialization.
 * Decoded host-api operations are dispatched by the shared HostServer service.
 */
import {
  isHostApiProtocolFailureResponse,
  makeHostApiProtocolFailureResponse,
  type HostApiProtocolFailureResponse,
  type HostApiRequest,
  type HostApiResponse,
} from "@ptools/host-api";
import * as Effect from "effect/Effect";
import { Hono } from "hono";
import { methodNotAllowed, type HostCloudflareError } from "../../errors.js";
import {
  errorResponse,
  runJsonWorkerRoute,
  type CloudflareWorkerHonoEnv,
} from "../http.js";
import {
  dispatchCloudflareHostApiRequest,
  readHostApiJsonRequest,
} from "../hostApiHttpAdapter.js";
import { requestOrigin, requirePublicWorkerAuth } from "../request.js";

export const hostApiRoutes = new Hono<CloudflareWorkerHonoEnv>()
  .post("/hosts/:hostId/api", (context) =>
    runJsonWorkerRoute(
      handleHostApiRoute({
        request: context.req.raw,
        hostId: context.req.param("hostId"),
        env: context.env,
      }),
    ),
  )
  .all("/hosts/:hostId/api", () => errorResponse(methodNotAllowed(["POST"])))
  .post("/hosts/:hostId/code-mode", (context) =>
    runJsonWorkerRoute(
      handleHostApiRoute({
        request: context.req.raw,
        hostId: context.req.param("hostId"),
        env: context.env,
        expectedOperation: "code_mode",
      }),
    ),
  )
  .all("/hosts/:hostId/code-mode", () =>
    errorResponse(methodNotAllowed(["POST"])),
  )
  .put("/hosts/:hostId/config", (context) =>
    runJsonWorkerRoute(
      handleHostApiRoute({
        request: context.req.raw,
        hostId: context.req.param("hostId"),
        env: context.env,
        expectedOperation: "configure",
      }),
    ),
  )
  .all("/hosts/:hostId/config", () => errorResponse(methodNotAllowed(["PUT"])))
  .put("/hosts/:hostId/secrets", (context) =>
    runJsonWorkerRoute(
      handleHostApiRoute({
        request: context.req.raw,
        hostId: context.req.param("hostId"),
        env: context.env,
        expectedOperation: "configure_secrets",
      }),
    ),
  )
  .all("/hosts/:hostId/secrets", () => errorResponse(methodNotAllowed(["PUT"])))
  .post("/hosts/:hostId/auth/status", (context) =>
    runJsonWorkerRoute(
      handleHostApiRoute({
        request: context.req.raw,
        hostId: context.req.param("hostId"),
        env: context.env,
        expectedOperation: "mcp_auth_status",
      }),
    ),
  )
  .all("/hosts/:hostId/auth/status", () =>
    errorResponse(methodNotAllowed(["POST"])),
  )
  .post("/hosts/:hostId/auth/:serverName", (context) =>
    runJsonWorkerRoute(
      handleHostApiRoute({
        request: context.req.raw,
        hostId: context.req.param("hostId"),
        env: context.env,
        expectedOperation: "start_mcp_auth",
        expectedServerName: context.req.param("serverName"),
      }),
    ),
  );

const handleHostApiRoute = (input: {
  readonly request: Request;
  readonly hostId: string;
  readonly env: CloudflareWorkerHonoEnv["Bindings"];
  readonly expectedOperation?: HostApiRequest["operation"];
  readonly expectedServerName?: string;
}): Effect.Effect<HostApiResponse, HostCloudflareError> =>
  Effect.gen(function* () {
    yield* requirePublicWorkerAuth(input);

    const decoded = yield* readHostApiJsonRequest(input.request);

    if (isHostApiProtocolFailureResponse(decoded)) {
      return decoded;
    }

    const checked = validateRouteOperation(decoded, input);

    if (isHostApiProtocolFailureResponse(checked)) {
      return checked;
    }

    return yield* dispatchCloudflareHostApiRequest({
      namespace: input.env.PTOOLS_CODE_MODE,
      hostId: input.hostId,
      origin: requestOrigin(input.request),
      request: checked,
    });
  });

const validateRouteOperation = (
  request: HostApiRequest,
  input: {
    readonly expectedOperation?: HostApiRequest["operation"];
    readonly expectedServerName?: string;
  },
): HostApiRequest | HostApiProtocolFailureResponse => {
  if (
    input.expectedOperation !== undefined &&
    request.operation !== input.expectedOperation
  ) {
    return makeHostApiProtocolFailureResponse({
      code: "unknown_operation",
      message: `Route expected ${input.expectedOperation}, received ${request.operation}.`,
    });
  }

  if (
    input.expectedServerName !== undefined &&
    request.operation === "start_mcp_auth" &&
    request.input.serverName !== input.expectedServerName
  ) {
    return makeHostApiProtocolFailureResponse({
      code: "invalid_host_api_request",
      message:
        "start_mcp_auth input.serverName must match the route serverName.",
    });
  }

  return request;
};
