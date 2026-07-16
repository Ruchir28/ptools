/** Cloudflare host discovery: logical host id -> named Durable Object handle. */
import { HostInstanceDiscovery } from "@ptools/host-api/effect";
import { Effect, Layer } from "effect";
import { WorkerIngressEnv } from "./workerIngressEnv.js";
import { makeCloudflareDurableObjectHostInstanceHandle } from "./cloudflareDurableObjectHostInstanceHandle.js";

export const CloudflareHostInstanceDiscoveryLive: Layer.Layer<
  HostInstanceDiscovery,
  never,
  WorkerIngressEnv
> = Layer.effect(
  HostInstanceDiscovery,
  Effect.gen(function* () {
    const env = yield* WorkerIngressEnv;
    return HostInstanceDiscovery.of({
      resolve: (hostId) =>
        Effect.succeed(
          makeCloudflareDurableObjectHostInstanceHandle({
            hostId,
            stub: env.PTOOLS_CODE_MODE.getByName(hostId),
          }),
        ),
    });
  }),
);
