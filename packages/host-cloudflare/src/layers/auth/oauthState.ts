import { AuthError } from "@ptools/auth";
import { Effect, Option, Schema } from "effect";
import {
  CODE_MODE_OBJECT_OAUTH_STATE_SECRET_KEY,
  codeModeObjectOAuthStateKey,
} from "./keys.js";
import type { CodeModeObjectStorageService } from "../platform.js";
import { CloudflareOAuthStatePayloadSchema } from "./types.js";

/**
 * Signed OAuth state helpers.
 *
 * Parameters:
 * - storage: Durable Object storage for CodeModeObject(hostId), used for the
 *   per-host HMAC secret and one issued oauth/state/<nonce> record.
 * - payload/rawState: state identity that binds callback provider, hostId,
 *   serverName, nonce, and expiry.
 */

export const signOAuthState = (input: {
  readonly storage: CodeModeObjectStorageService;
  readonly payload: Parameters<
    typeof CloudflareOAuthStatePayloadSchema.make
  >[0];
}): Effect.Effect<string, AuthError> =>
  Effect.gen(function* () {
    const payload = yield* Effect.try({
      try: () => CloudflareOAuthStatePayloadSchema.make(input.payload),
      catch: invalidOAuthStateError,
    });
    const secret = yield* loadOrCreateOAuthStateSecret(input.storage);
    const encodedPayload = base64UrlEncodeJson(payload);
    const signature = yield* hmacSha256Base64Url({
      secret,
      value: encodedPayload,
    });

    yield* input.storage
      .put(codeModeObjectOAuthStateKey(payload.nonce), payload)
      .pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "Failed to store Cloudflare OAuth state.",
              cause,
            }),
        ),
      );

    return `${encodedPayload}.${signature}`;
  });

/**
 * Verifies and consumes one issued OAuth callback state.
 *
 * Consumption deliberately happens immediately after the signature, callback
 * identity, expiry, and issued-state match are verified, before authorization
 * code exchange begins. Burning the nonce here makes the callback single-use
 * even when token exchange later fails; the user must then begin a new flow.
 *
 * Keep the issued-state load, comparison, and deletion together without
 * inserting external I/O between them. Durable Object storage input gates
 * protect this storage-only sequence from interleaving callback requests.
 */
export const verifyAndConsumeOAuthState = (input: {
  readonly storage: CodeModeObjectStorageService;
  readonly rawState: string;
  readonly expectedHostId: string;
  readonly expectedProvider: string;
}): Effect.Effect<typeof CloudflareOAuthStatePayloadSchema.Type, AuthError> =>
  Effect.gen(function* () {
    const secret = yield* loadOrCreateOAuthStateSecret(input.storage);
    const { encodedPayload, signature } = yield* parseSignedOAuthState(
      input.rawState,
    );
    const expectedSignature = yield* hmacSha256Base64Url({
      secret,
      value: encodedPayload,
    });
    yield* timingSafeEquals(signature, expectedSignature).pipe(
      Effect.filterOrFail(Boolean, () => invalidOAuthStateError()),
    );

    const payload = yield* parseOAuthStatePayload(encodedPayload).pipe(
      Effect.filterOrFail(
        (candidate) => oauthStateMatchesCallback(candidate, input),
        () => invalidOAuthStateError(),
      ),
    );

    const stateKey = codeModeObjectOAuthStateKey(payload.nonce);
    yield* loadIssuedOAuthState(input.storage, stateKey).pipe(
      Effect.filterOrFail(
        (issuedState) => issuedStateMatchesCallbackState(issuedState, payload),
        () => invalidOAuthStateError(),
      ),
    );

    yield* input.storage.delete(stateKey).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Failed to delete Cloudflare OAuth state.",
            cause,
          }),
      ),
    );

    return payload;
  });

export const loadOrCreateOAuthStateSecret = (
  storage: CodeModeObjectStorageService,
): Effect.Effect<string, AuthError> =>
  Effect.gen(function* () {
    const existing = yield* storage
      .get<string>(CODE_MODE_OBJECT_OAUTH_STATE_SECRET_KEY)
      .pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "Failed to load Cloudflare OAuth state secret.",
              cause,
            }),
        ),
      );

    return yield* existing.pipe(
      Option.match({
        onNone: () => createAndStoreOAuthStateSecret(storage),
        onSome: Effect.succeed,
      }),
    );
  });

const SignedOAuthStatePartsSchema = Schema.Tuple(
  Schema.NonEmptyString,
  Schema.NonEmptyString,
);

/**
 * Schema for a JSON string that contains a CloudflareOAuthStatePayload.
 * Parses the JSON and then validates the resulting object.
 */
const EncodedCloudflareOAuthStatePayloadSchema = Schema.parseJson(
  CloudflareOAuthStatePayloadSchema,
);

/**
 * Deep equality check for OAuth state payloads.
 * Used to compare the state from the callback URL with the state in storage.
 */
const issuedStateMatchesCallbackState = Schema.equivalence(
  CloudflareOAuthStatePayloadSchema,
);

const parseSignedOAuthState = (
  rawState: string,
): Effect.Effect<
  { readonly encodedPayload: string; readonly signature: string },
  AuthError
> =>
  Schema.decodeUnknown(SignedOAuthStatePartsSchema)(rawState.split(".")).pipe(
    Effect.map(([encodedPayload, signature]) => ({
      encodedPayload,
      signature,
    })),
    Effect.mapError(invalidOAuthStateError),
  );

const parseOAuthStatePayload = (
  encodedPayload: string,
): Effect.Effect<typeof CloudflareOAuthStatePayloadSchema.Type, AuthError> =>
  Effect.try({
    try: () => base64UrlDecodeText(encodedPayload),
    catch: invalidOAuthStateError,
  }).pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknown(EncodedCloudflareOAuthStatePayloadSchema)(json).pipe(
        Effect.mapError(invalidOAuthStateError),
      ),
    ),
  );

const loadIssuedOAuthState = (
  storage: CodeModeObjectStorageService,
  stateKey: string,
): Effect.Effect<typeof CloudflareOAuthStatePayloadSchema.Type, AuthError> =>
  storage.get<unknown>(stateKey).pipe(
    Effect.mapError(
      (cause) =>
        new AuthError({
          message: "Failed to load Cloudflare OAuth state.",
          cause,
        }),
    ),
    Effect.flatMap((stored) =>
      stored.pipe(
        Option.match({
          onNone: invalidOAuthStateError,
          onSome: (record) =>
            Schema.decodeUnknown(CloudflareOAuthStatePayloadSchema)(
              record,
            ).pipe(Effect.mapError(invalidOAuthStateError)),
        }),
      ),
    ),
  );

const oauthStateMatchesCallback = (
  payload: typeof CloudflareOAuthStatePayloadSchema.Type,
  expected: {
    readonly expectedHostId: string;
    readonly expectedProvider: string;
  },
): boolean =>
  payload.hostId === expected.expectedHostId &&
  payload.provider === expected.expectedProvider &&
  Date.parse(payload.expiresAt) > Date.now();

const createAndStoreOAuthStateSecret = (
  storage: CodeModeObjectStorageService,
): Effect.Effect<string, AuthError> =>
  Effect.gen(function* () {
    const created = yield* createRandomSecret();

    yield* storage.put(CODE_MODE_OBJECT_OAUTH_STATE_SECRET_KEY, created).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Failed to store Cloudflare OAuth state secret.",
            cause,
          }),
      ),
    );

    return created;
  });

const invalidOAuthStateError = (cause?: unknown): AuthError =>
  Option.fromNullable(cause).pipe(
    Option.match({
      onNone: () => new AuthError({ message: "Invalid OAuth state." }),
      onSome: (definedCause) =>
        new AuthError({
          message: "Invalid OAuth state.",
          cause: definedCause,
        }),
    }),
  );

const createRandomSecret = (): Effect.Effect<string> =>
  Effect.sync(() => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return base64UrlEncodeBytes(bytes);
  });

const hmacSha256Base64Url = (input: {
  readonly secret: string;
  readonly value: string;
}): Effect.Effect<string, AuthError> =>
  Effect.gen(function* () {
    const key = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(input.secret),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        ),
      catch: (cause) =>
        new AuthError({
          message: "Failed to import OAuth state signing key.",
          cause,
        }),
    });
    const signature = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input.value)),
      catch: (cause) =>
        new AuthError({
          message: "Failed to sign OAuth state.",
          cause,
        }),
    });

    return base64UrlEncodeBytes(new Uint8Array(signature));
  });

const timingSafeEquals = (
  actual: string,
  expected: string,
): Effect.Effect<boolean> =>
  Effect.sync(() => {
    const encoder = new TextEncoder();
    const actualBytes = encoder.encode(actual);
    const expectedBytes = encoder.encode(expected);
    const lengthsMatch = actualBytes.byteLength === expectedBytes.byteLength;

    return lengthsMatch
      ? crypto.subtle.timingSafeEqual(actualBytes, expectedBytes)
      : !crypto.subtle.timingSafeEqual(actualBytes, actualBytes);
  });

const base64UrlEncodeJson = (value: unknown): string =>
  base64UrlEncodeText(JSON.stringify(value));

const base64UrlEncodeText = (value: string): string =>
  base64UrlEncodeBytes(new TextEncoder().encode(value));

const base64UrlEncodeBytes = (bytes: Uint8Array): string => {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};

const base64UrlDecodeText = (value: string): string => {
  const base64 = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new TextDecoder().decode(bytes);
};
