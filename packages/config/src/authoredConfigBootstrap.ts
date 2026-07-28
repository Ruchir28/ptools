/**
 * Explicit authored-file bootstrap helpers for product entrypoints.
 *
 * Hosts never call these functions. A CLI or application may decode a chosen
 * file, anchor relative stdio working directories to that file, and submit only
 * explicitly referenced environment values through Host API operations.
 */
import { Effect, Option, Schema } from "effect";
import {
  UserPtoolsConfig,
  type UserPtoolsConfig as UserPtoolsConfigType,
} from "./contracts/authoredPtoolsConfig.js";
import { ServerConfigError } from "./configErrors.js";

const ENV_PLACEHOLDER_PATTERN = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Decode one selected JSON file into the authored Host API config contract. */
export const parseUserPtoolsConfigJson = (
  raw: string,
  source = "ptools config",
): Effect.Effect<UserPtoolsConfigType, ServerConfigError> =>
  Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: (cause) =>
      new ServerConfigError({
        message: `Invalid JSON in ${source}`,
        cause,
      }),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknown(UserPtoolsConfig)(value, {
        errors: "all",
        onExcessProperty: "error",
      }),
    ),
    Effect.mapError((cause) =>
      cause instanceof ServerConfigError
        ? cause
        : new ServerConfigError({
            message: `Invalid ptools config in ${source}: ${cause.message}`,
            cause,
          }),
    ),
  );

/** Anchor relative cwd values only for authored stdio (`command`) entries. */
export const normalizeUserPtoolsConfigStdioCwds = (
  config: UserPtoolsConfigType,
  resolveCwd: (cwd: string) => string,
): UserPtoolsConfigType => ({
  ...config,
  mcpServers: Object.fromEntries(
    Object.entries(config.mcpServers).map(([name, server]) => [
      name,
      Option.isSome(server.command)
        ? { ...server, cwd: Option.map(server.cwd, resolveCwd) }
        : server,
    ]),
  ),
});

/** Return the unique `${env:NAME}` references present in validated authored data. */
export const collectUserPtoolsConfigEnvReferences = (
  config: UserPtoolsConfigType,
): ReadonlyArray<string> => {
  const encoded = Schema.encodeSync(UserPtoolsConfig)({
    ...config,
    mcpServers: Object.fromEntries(
      Object.entries(config.mcpServers).filter(
        ([, server]) =>
          !Option.contains(server.enabled, false) &&
          !Option.contains(server.disabled, true),
      ),
    ),
  });
  const names = new Set<string>();
  collectReferences(encoded, names);
  return [...names].sort();
};

const collectReferences = (value: unknown, names: Set<string>): void => {
  if (typeof value === "string") {
    for (const match of value.matchAll(ENV_PLACEHOLDER_PATTERN)) {
      const name = match[1];
      if (name !== undefined) names.add(name);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, names);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) collectReferences(nested, names);
  }
};
