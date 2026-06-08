import type { CodeModeRequest, CodeModeResponse } from "@ptools/code-mode-api";
import { parseCodeModeRequest } from "@ptools/code-mode-api";
import * as Effect from "effect/Effect";
import { Hono } from "hono";
import type {
  CodeModeObjectRpc,
  ConfigureCodeModeObjectError,
  ConfigureCodeModeObjectSecretsResult,
  ConfigureCodeModeObjectResult,
} from "../objects/CodeModeObject.js";
import {
  HostCloudflareError,
  codeModeUnavailable,
  invalidCodeModeRequest,
  invalidJson,
  methodNotAllowed,
  misconfiguredWorker,
  notFound,
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

cloudflareWorkerApp.put("/hosts/:hostId/config", (context) =>
  handleConfigureRoute({
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

cloudflareWorkerApp.put("/hosts/:hostId/secrets", (context) =>
  handleConfigureSecretsRoute({
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

cloudflareWorkerApp.all("/hosts/:hostId/config", () =>
  errorResponse(methodNotAllowed(["PUT"])),
);

cloudflareWorkerApp.all("/hosts/:hostId/secrets", () =>
  errorResponse(methodNotAllowed(["PUT"])),
);

cloudflareWorkerApp.notFound(() => errorResponse(notFound()));

const handleCodeModeRoute = (input: {
  readonly request: Request;
  readonly hostId: string;
  readonly env: PtoolsWorkerEnv;
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

const handleConfigureRoute = (input: {
  readonly request: Request;
  readonly hostId: string;
  readonly env: PtoolsWorkerEnv;
}): Effect.Effect<ConfigureCodeModeObjectResult, HostCloudflareError> =>
  Effect.gen(function* () {
    yield* requirePublicWorkerAuth(input);

    const rawConfigJson = yield* Effect.tryPromise({
      try: () => input.request.text(),
      catch: invalidJson,
    });

    return yield* configureCodeModeObject({
      namespace: input.env.PTOOLS_CODE_MODE,
      hostId: input.hostId,
      rawConfigJson,
    });
  });

const handleConfigureSecretsRoute = (input: {
  readonly request: Request;
  readonly hostId: string;
  readonly env: PtoolsWorkerEnv;
}): Effect.Effect<ConfigureCodeModeObjectSecretsResult, HostCloudflareError> =>
  Effect.gen(function* () {
    yield* requirePublicWorkerAuth(input);

    const rawSecretsJson = yield* Effect.tryPromise({
      try: () => input.request.text(),
      catch: invalidJson,
    });

    return yield* configureCodeModeObjectSecrets({
      namespace: input.env.PTOOLS_CODE_MODE,
      hostId: input.hostId,
      rawSecretsJson,
    });
  });

const requirePublicWorkerAuth = (input: {
  readonly request: Request;
  readonly env: PtoolsWorkerEnv;
}): Effect.Effect<void, HostCloudflareError> =>
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

const configureCodeModeObject = (input: {
  readonly namespace: CodeModeObjectNamespace;
  readonly hostId: string;
  readonly rawConfigJson: string;
}): Effect.Effect<ConfigureCodeModeObjectResult, HostCloudflareError> =>
  Effect.tryPromise({
    try: () =>
      input.namespace.getByName(input.hostId).configure({
        rawConfigJson: input.rawConfigJson,
      }),
    catch: codeModeUnavailable,
  }).pipe(
    Effect.flatMap((response) =>
      response.ok
        ? Effect.succeed(response.result)
        : Effect.fail(configureRpcError(response.error)),
    ),
  );

const configureCodeModeObjectSecrets = (input: {
  readonly namespace: CodeModeObjectNamespace;
  readonly hostId: string;
  readonly rawSecretsJson: string;
}): Effect.Effect<ConfigureCodeModeObjectSecretsResult, HostCloudflareError> =>
  Effect.tryPromise({
    try: () =>
      input.namespace.getByName(input.hostId).configureSecrets({
        rawSecretsJson: input.rawSecretsJson,
      }),
    catch: codeModeUnavailable,
  }).pipe(
    Effect.flatMap((response) =>
      response.ok
        ? Effect.succeed(response.result)
        : Effect.fail(configureRpcError(response.error)),
    ),
  );

const configureRpcError = (
  error: ConfigureCodeModeObjectError,
): HostCloudflareError => {
  switch (error.code) {
    case "invalid_config":
      return new HostCloudflareError({
        code: "invalid_config",
        status: 400,
        message: "Invalid host config",
      });
    case "invalid_secrets":
      return new HostCloudflareError({
        code: "invalid_secrets",
        status: 400,
        message: "Invalid host secrets",
      });
    case "unsupported_config":
      return new HostCloudflareError({
        code: "unsupported_config",
        status: 400,
        message: error.message,
      });
    case "config_storage_unavailable":
      return codeModeUnavailable(error);
  }
};

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
