import { AsyncEntry } from "@napi-rs/keyring";
import { CredentialError, CredentialsStore } from "@ptools/auth";
import { Effect, Layer } from "effect";

/** Keyring-backed credential store for Node MCP OAuth client/tokens. */
export const NodeCredentialsStoreLive = (options: {
  readonly serviceName: string;
}): Layer.Layer<CredentialsStore, never, never> =>
  Layer.sync(CredentialsStore, () => ({
    get: (key) =>
      Effect.tryPromise({
        try: () => new AsyncEntry(options.serviceName, key).getPassword(),
        catch: (cause) =>
          new CredentialError({
            message: `Failed to read credential ${key}`,
            cause,
          }),
      }).pipe(Effect.map((value) => value ?? undefined)),
    set: (key, value) =>
      Effect.tryPromise({
        try: () => new AsyncEntry(options.serviceName, key).setPassword(value),
        catch: (cause) =>
          new CredentialError({
            message: `Failed to write credential ${key}`,
            cause,
          }),
      }),
    delete: (key) =>
      Effect.tryPromise({
        try: async () => {
          await new AsyncEntry(options.serviceName, key)
            .deleteCredential()
            .catch(() => false);
        },
        catch: (cause) =>
          new CredentialError({
            message: `Failed to delete credential ${key}`,
            cause,
          }),
      }),
  }));
