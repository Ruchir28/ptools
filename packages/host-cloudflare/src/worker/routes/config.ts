import * as Effect from "effect/Effect";
import { Hono } from "hono";
import {
  invalidJson,
  methodNotAllowed,
  type HostCloudflareError,
} from "../../errors.js";
import type {
  ConfigureCodeModeObjectSecretsResult,
  ConfigureCodeModeObjectResult,
} from "../../objects/codeModeObject/rpc.js";
import {
  configureCodeModeObject,
  configureCodeModeObjectSecrets,
} from "../codeModeObjectRpc.js";
import {
  errorResponse,
  runJsonWorkerRoute,
  type CloudflareWorkerHonoEnv,
} from "../http.js";
import { requirePublicWorkerAuth } from "../request.js";

export const configRoutes = new Hono<CloudflareWorkerHonoEnv>()
  .put("/hosts/:hostId/config", (context) =>
    runJsonWorkerRoute(
      handleConfigureRoute({
        request: context.req.raw,
        hostId: context.req.param("hostId"),
        env: context.env,
      }),
    ),
  )
  .all("/hosts/:hostId/config", () => errorResponse(methodNotAllowed(["PUT"])))
  .put("/hosts/:hostId/secrets", (context) =>
    runJsonWorkerRoute(
      handleConfigureSecretsRoute({
        request: context.req.raw,
        hostId: context.req.param("hostId"),
        env: context.env,
      }),
    ),
  )
  .all("/hosts/:hostId/secrets", () =>
    errorResponse(methodNotAllowed(["PUT"])),
  );

const handleConfigureRoute = (input: {
  readonly request: Request;
  readonly hostId: string;
  readonly env: CloudflareWorkerHonoEnv["Bindings"];
}): Effect.Effect<ConfigureCodeModeObjectResult, HostCloudflareError> =>
  Effect.gen(function* () {
    yield* requirePublicWorkerAuth(input);
    const rawConfigJson = yield* readRequestText(input.request);

    return yield* configureCodeModeObject({
      namespace: input.env.PTOOLS_CODE_MODE,
      hostId: input.hostId,
      rawConfigJson,
    });
  });

const handleConfigureSecretsRoute = (input: {
  readonly request: Request;
  readonly hostId: string;
  readonly env: CloudflareWorkerHonoEnv["Bindings"];
}): Effect.Effect<ConfigureCodeModeObjectSecretsResult, HostCloudflareError> =>
  Effect.gen(function* () {
    yield* requirePublicWorkerAuth(input);
    const rawSecretsJson = yield* readRequestText(input.request);

    return yield* configureCodeModeObjectSecrets({
      namespace: input.env.PTOOLS_CODE_MODE,
      hostId: input.hostId,
      rawSecretsJson,
    });
  });

const readRequestText = (
  request: Request,
): Effect.Effect<string, HostCloudflareError> =>
  Effect.tryPromise({
    try: () => request.text(),
    catch: invalidJson,
  });
