import type { CodeModeResponse } from "@ptools/code-mode-api";
import * as Effect from "effect/Effect";
import { Hono } from "hono";
import { methodNotAllowed, type HostCloudflareError } from "../../errors.js";
import { callCodeModeObject } from "../codeModeObjectRpc.js";
import {
  errorResponse,
  runJsonWorkerRoute,
  type CloudflareWorkerHonoEnv,
} from "../http.js";
import { readCodeModeRequest, requirePublicWorkerAuth } from "../request.js";

export const codeModeRoutes = new Hono<CloudflareWorkerHonoEnv>()
  .post("/hosts/:hostId/code-mode", (context) =>
    runJsonWorkerRoute(
      handleCodeModeRoute({
        request: context.req.raw,
        hostId: context.req.param("hostId"),
        env: context.env,
      }),
    ),
  )
  .all("/hosts/:hostId/code-mode", () =>
    errorResponse(methodNotAllowed(["POST"])),
  );

const handleCodeModeRoute = (input: {
  readonly request: Request;
  readonly hostId: string;
  readonly env: CloudflareWorkerHonoEnv["Bindings"];
}): Effect.Effect<CodeModeResponse, HostCloudflareError> =>
  Effect.gen(function* () {
    yield* requirePublicWorkerAuth(input);
    const request = yield* readCodeModeRequest(input.request);

    return yield* callCodeModeObject({
      namespace: input.env.PTOOLS_CODE_MODE,
      hostId: input.hostId,
      request,
    });
  });
