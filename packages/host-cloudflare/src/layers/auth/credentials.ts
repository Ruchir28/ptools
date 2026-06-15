import { CredentialError, CredentialsStore } from "@ptools/auth";
import { Effect, Layer, Option } from "effect";
import { CodeModeObjectStorage } from "../platform.js";
import { codeModeObjectCredentialKey } from "./keys.js";

/**
 * Durable Object backed implementation of the shared CredentialsStore service.
 *
 * Requires:
 * - CodeModeObjectStorage: the Durable Object storage handle for the current
 *   CodeModeObject(hostId).
 *
 * Stores each OAuth credential value separately under credentials/<key>.
 */
export const DurableObjectCredentialsStoreLayer: Layer.Layer<
  CredentialsStore,
  never,
  CodeModeObjectStorage
> = Layer.effect(
  CredentialsStore,
  Effect.gen(function* () {
    const storage = yield* CodeModeObjectStorage;

    return {
      get: (key) =>
        storage.get<string>(codeModeObjectCredentialKey(key)).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.mapError(
            (cause) =>
              new CredentialError({
                message: `Failed to read Cloudflare credential ${key}`,
                cause,
              }),
          ),
        ),
      set: (key, value) =>
        storage.put(codeModeObjectCredentialKey(key), value).pipe(
          Effect.mapError(
            (cause) =>
              new CredentialError({
                message: `Failed to write Cloudflare credential ${key}`,
                cause,
              }),
          ),
        ),
      delete: (key) =>
        storage.delete(codeModeObjectCredentialKey(key)).pipe(
          Effect.mapError(
            (cause) =>
              new CredentialError({
                message: `Failed to delete Cloudflare credential ${key}`,
                cause,
              }),
          ),
        ),
    };
  }),
);
