/**
 * Effect service tags for loading config and resolving secrets.
 *
 * Platform packages provide these services from files, Durable Object storage,
 * process env, or other host-owned capabilities.
 */
import { Context, Effect } from "effect";
import type { ResolvedPtoolsConfig } from "../contracts/index.js";
import type { ServerConfigError } from "../configErrors.js";

/** Effect service that loads a fully resolved ptools config. */
export class ConfigSource extends Context.Tag("@ptools/ConfigSource")<
  ConfigSource,
  {
    readonly load: Effect.Effect<ResolvedPtoolsConfig, ServerConfigError>;
  }
>() {}

/** Effect service that resolves secret names referenced from config values. */
export class SecretResolver extends Context.Tag("@ptools/SecretResolver")<
  SecretResolver,
  {
    readonly get: (name: string) => Effect.Effect<string, ServerConfigError>;
  }
>() {}
