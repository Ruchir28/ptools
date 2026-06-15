import * as Effect from "effect/Effect";
import type { HostCloudflareError } from "../errors.js";
import type { PtoolsWorkerEnv } from "./ingress.js";

export type CloudflareWorkerHonoEnv = {
  readonly Bindings: PtoolsWorkerEnv;
};

export const runWorkerRoute = <A>(
  effect: Effect.Effect<A, HostCloudflareError>,
  onSuccess: (value: A) => Response,
): Promise<Response> =>
  effect.pipe(
    Effect.map(onSuccess),
    Effect.catchTag("HostCloudflareError", (error) =>
      Effect.succeed(errorResponse(error)),
    ),
    Effect.runPromise,
  );

export const runJsonWorkerRoute = <A>(
  effect: Effect.Effect<A, HostCloudflareError>,
): Promise<Response> => runWorkerRoute(effect, (value) => Response.json(value));

export const errorResponse = (error: HostCloudflareError): Response =>
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
