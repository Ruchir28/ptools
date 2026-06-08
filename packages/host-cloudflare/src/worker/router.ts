import type {
  CodeModeRequest,
  CodeModeResponse,
} from "@ptools/code-mode-api";
import { parseCodeModeRequest } from "@ptools/code-mode-api";
import * as Effect from "effect/Effect";
import { Hono } from "hono";
import type { CodeModeObjectRpc } from "../objects/CodeModeObject.js";
import {
  codeModeUnavailable,
  invalidCodeModeRequest,
  invalidJson,
  methodNotAllowed,
  misconfiguredWorker,
  notFound,
  type HostCloudflareError,
} from "../errors.js";
import type { PtoolsWorkerEnv } from "./ingress.js";
import { verifyPublicWorkerAuth } from "./publicAuth.js";

interface CodeModeObjectNamespace {
  readonly getByName: (hostId: string) => CodeModeObjectRpc;
}

type CloudflareWorkerHonoEnv = {
  readonly Bindings: PtoolsWorkerEnv;
};

export const cloudflareWorkerApp = new Hono<CloudflareWorkerHonoEnv>();

cloudflareWorkerApp.get("/health", (context) => context.json({ ok: true }));

cloudflareWorkerApp.post("/hosts/:hostId/code-mode", (context) =>
  handleCodeModeRoute({
    request: context.req.raw,
    hostId: context.req.param("hostId"),
    env: context.env,
  }).pipe(
    Effect.map((body) => Response.json(body)),
    Effect.catchTag("HostCloudflareError", (error) =>
      Effect.succeed(errorResponse(error)),
    ),
    Effect.runPromise,
  ),
);

cloudflareWorkerApp.all("/health", () =>
  errorResponse(methodNotAllowed(["GET"])),
);

cloudflareWorkerApp.all("/hosts/:hostId/code-mode", () =>
  errorResponse(methodNotAllowed(["POST"])),
);

cloudflareWorkerApp.notFound(() => errorResponse(notFound()));

const handleCodeModeRoute = (input: {
  readonly request: Request;
  readonly hostId: string;
  readonly env: PtoolsWorkerEnv;
}): Effect.Effect<CodeModeResponse, HostCloudflareError> =>
  Effect.gen(function* () {
    if (input.env.PTOOLS_PUBLIC_ACCESS_TOKEN.length === 0) {
      return yield* Effect.fail(
        misconfiguredWorker("PTOOLS_PUBLIC_ACCESS_TOKEN must be configured"),
      );
    }

    yield* verifyPublicWorkerAuth({
      request: input.request,
      accessToken: input.env.PTOOLS_PUBLIC_ACCESS_TOKEN,
    });

    const request = yield* readCodeModeRequest(input.request);

    return yield* callCodeModeObject({
      namespace: input.env.PTOOLS_CODE_MODE,
      hostId: input.hostId,
      request,
    });
  });

const readCodeModeRequest = (
  request: Request,
): Effect.Effect<CodeModeRequest, HostCloudflareError> =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: invalidJson,
  }).pipe(
    Effect.flatMap((value) =>
      parseCodeModeRequest(value).pipe(Effect.mapError(invalidCodeModeRequest)),
    ),
  );

const callCodeModeObject = (input: {
  readonly namespace: CodeModeObjectNamespace;
  readonly hostId: string;
  readonly request: CodeModeRequest;
}): Effect.Effect<CodeModeResponse, HostCloudflareError> =>
  Effect.tryPromise({
    try: () => input.namespace.getByName(input.hostId).call(input.request),
    catch: codeModeUnavailable,
  });

const errorResponse = (error: HostCloudflareError): Response =>
  Response.json(
    {
      error: {
        code: error.code,
        message: error.message,
      },
    },
    error.headers === undefined
      ? { status: error.status }
      : { status: error.status, headers: error.headers },
  );
