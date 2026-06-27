import * as Effect from "effect/Effect";
import { HostCloudflareError, misconfiguredWorker } from "../errors.js";
import type { PtoolsWorkerEnv } from "./ingress.js";
import { verifyPublicWorkerAuth } from "./publicAuth.js";

export const requirePublicWorkerAuth = (input: {
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

export const requestOrigin = (request: Request): string =>
  new URL(request.url).origin;

export const readMcpOAuthCallbackBody = (
  request: Request,
): Effect.Effect<string, HostCloudflareError> => {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";

  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Effect.tryPromise({
      try: async () => {
        const formData = await request.formData();
        const params = new URLSearchParams();

        for (const [key, value] of formData) {
          if (typeof value === "string") {
            params.append(key, value);
          }
        }

        return params.toString();
      },
      catch: invalidOAuthCallbackBody,
    });
  }

  return Effect.tryPromise({
    try: () => request.text(),
    catch: invalidOAuthCallbackBody,
  });
};

const invalidOAuthCallbackBody = (cause: unknown): HostCloudflareError =>
  new HostCloudflareError({
    code: "invalid_oauth_callback",
    status: 400,
    message: "Invalid OAuth callback body",
    cause,
  });
