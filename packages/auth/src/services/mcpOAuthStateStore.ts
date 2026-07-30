/**
 * Shared MCP OAuth state signing and issued-state storage.
 *
 * Plain-English meaning of "MCP OAuth state store": this is the shared object
 * that creates and verifies the short-lived `state` value used while the user's
 * browser is away at an OAuth authorization page. The platform only supplies an
 * exact-key `HostSecretStorage` that is already scoped to one host.
 *
 * Example flow:
 *
 * ```txt
 * Start OAuth for host "demo", provider "github"
 *   provider calls McpOAuthStateStore.sign({ payload })
 *
 * McpOAuthStateStore.layer
 *   loads or creates signing secret at: oauth/state-secret
 *   stores issued nonce at: oauth/state/<nonce>
 *   returns browser state: base64url(payload).signature
 *
 * OAuth callback returns with ?state=...
 *   host calls verifyAndConsume({ rawState, expectedHostId, expectedProvider })
 *   store verifies signature + host/provider binding + expiry
 *   deletes oauth/state/<nonce> so the callback cannot be replayed
 * ```
 *
 * This is intentionally separate from `McpOAuthCredentialStore`: state is a
 * short-lived browser callback/replay-protection protocol; credentials are the
 * reusable tokens/client/discovery data saved after authorization succeeds.
 */
import {
  HostSecretStorage,
  type HostSecretStorageService,
} from "@ptools/config";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { AuthError } from "../authErrors.js";
import { McpOAuthStatePayload } from "../contracts/index.js";

/** Exact key for the per-host HMAC secret used to sign OAuth state values. */
export const MCP_OAUTH_STATE_SECRET_KEY = "oauth/state-secret";

/** Prefix for issued, single-use OAuth state nonce records. */
export const MCP_OAUTH_STATE_KEY_PREFIX = "oauth/state/";

/** Convert a generated nonce into the exact issued-state storage key. */
export const mcpOAuthStateKey = (nonce: string): string =>
  `${MCP_OAUTH_STATE_KEY_PREFIX}${nonce}`;

export interface McpOAuthStateStoreService {
  /**
   * Sign, persist, and return a browser-safe OAuth `state` value.
   *
   * This is called when an MCP SDK OAuth provider starts browser
   * authorization. It validates the payload, signs the encoded payload with a
   * per-host secret, and stores the nonce record so the callback can be consumed
   * exactly once.
   */
  readonly sign: (input: {
    readonly payload: Parameters<typeof McpOAuthStatePayload.make>[0];
  }) => Effect.Effect<string, AuthError>;
  /**
   * Verify a callback state and consume its stored nonce exactly once.
   *
   * This is called by the host OAuth callback route before exchanging the
   * authorization code. It checks signature, host/provider binding, expiry, and
   * stored nonce equality, then deletes the nonce to prevent replay.
   */
  readonly verifyAndConsume: (input: {
    readonly rawState: string;
    readonly expectedHostId: string;
    readonly expectedProvider: string;
  }) => Effect.Effect<McpOAuthStatePayload, AuthError>;
}

/**
 * Shared OAuth state store backed by host-scoped secret storage.
 *
 * This service owns short-lived OAuth callback state only. It does not store
 * long-lived OAuth tokens or client registrations; those belong to
 * `McpOAuthCredentialStore`.
 */
export class McpOAuthStateStore extends Context.Service<McpOAuthStateStore>()(
  "@ptools/McpOAuthStateStore",
  {
    make: Effect.gen(function* () {
      const secretStorage = yield* HostSecretStorage;

      return makeMcpOAuthStateStoreService(secretStorage);
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}

const makeMcpOAuthStateStoreService = (
  secretStorage: HostSecretStorageService,
): McpOAuthStateStoreService => {
  /** Load the host-local signing secret, creating it on first OAuth flow. */
  const loadOrCreateOAuthStateSecret = (): Effect.Effect<string, AuthError> =>
    Effect.gen(function* () {
      const existing = yield* secretStorage
        .get(MCP_OAUTH_STATE_SECRET_KEY)
        .pipe(
          Effect.mapError(
            (cause) =>
              new AuthError({
                message: "Failed to load MCP OAuth state secret.",
                cause,
              }),
          ),
        );

      return yield* existing.pipe(
        Option.match({
          onNone: createAndStoreOAuthStateSecret,
          onSome: Effect.succeed,
        }),
      );
    });

  const createAndStoreOAuthStateSecret = (): Effect.Effect<string, AuthError> =>
    Effect.gen(function* () {
      const created = yield* createRandomSecret();

      yield* secretStorage.put(MCP_OAUTH_STATE_SECRET_KEY, created).pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "Failed to store MCP OAuth state secret.",
              cause,
            }),
        ),
      );

      return created;
    });

  const loadIssuedOAuthState = (
    stateKey: string,
  ): Effect.Effect<McpOAuthStatePayload, AuthError> =>
    secretStorage.get(stateKey).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Failed to load MCP OAuth state.",
            cause,
          }),
      ),
      Effect.flatMap((stored) =>
        stored.pipe(
          Option.match({
            onNone: () => Effect.fail(invalidOAuthStateError()),
            onSome: (record) =>
              Schema.decodeUnknownEffect(EncodedMcpOAuthStatePayload)(
                record,
              ).pipe(Effect.mapError(invalidOAuthStateError)),
          }),
        ),
      ),
    );

  return {
    sign: (input) =>
      Effect.gen(function* () {
        const payload = yield* Effect.try({
          try: () => McpOAuthStatePayload.make(input.payload),
          catch: invalidOAuthStateError,
        });
        const secret = yield* loadOrCreateOAuthStateSecret();
        const encodedPayload = base64UrlEncodeJson(payload);
        const signature = yield* hmacSha256Base64Url({
          secret,
          value: encodedPayload,
        });

        // Persist the issued state by exact nonce key. The callback must find
        // this same record before it is allowed to exchange a code.
        yield* secretStorage
          .put(mcpOAuthStateKey(payload.nonce), JSON.stringify(payload))
          .pipe(
            Effect.mapError(
              (cause) =>
                new AuthError({
                  message: "Failed to store MCP OAuth state.",
                  cause,
                }),
            ),
          );

        return `${encodedPayload}.${signature}`;
      }),
    verifyAndConsume: (input) =>
      Effect.gen(function* () {
        const secret = yield* loadOrCreateOAuthStateSecret();
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

        const stateKey = mcpOAuthStateKey(payload.nonce);

        // The signed payload alone is not enough. The nonce must also have been
        // issued by this host and still exist in storage, which makes callback
        // state single-use and host-local.
        yield* loadIssuedOAuthState(stateKey).pipe(
          Effect.filterOrFail(
            (issuedState) =>
              issuedStateMatchesCallbackState(issuedState, payload),
            () => invalidOAuthStateError(),
          ),
        );

        // Burn the nonce before returning. If later token exchange fails, the
        // user must start a fresh authorization flow instead of replaying the
        // same callback.
        yield* secretStorage.delete(stateKey).pipe(
          Effect.mapError(
            (cause) =>
              new AuthError({
                message: "Failed to delete MCP OAuth state.",
                cause,
              }),
          ),
        );

        return payload;
      }),
  } satisfies McpOAuthStateStoreService;
};

/**
 * Parts of browser OAuth `state` after `rawState.split(".")`:
 *   [0] encodedPayload — base64url(JSON of McpOAuthStatePayload)
 *   [1] signature      — HMAC-SHA256(encodedPayload) as base64url
 */
const SignedOAuthStatePartsSchema = Schema.Tuple([
  Schema.NonEmptyString,
  Schema.NonEmptyString,
]);

const EncodedMcpOAuthStatePayload = Schema.fromJsonString(McpOAuthStatePayload);
const issuedStateMatchesCallbackState =
  Schema.toEquivalence(McpOAuthStatePayload);

const parseSignedOAuthState = (
  rawState: string,
): Effect.Effect<
  { readonly encodedPayload: string; readonly signature: string },
  AuthError
> =>
  Schema.decodeUnknownEffect(SignedOAuthStatePartsSchema)(
    rawState.split("."),
  ).pipe(
    Effect.map(([encodedPayload, signature]) => ({
      encodedPayload,
      signature,
    })),
    Effect.mapError(invalidOAuthStateError),
  );

const parseOAuthStatePayload = (
  encodedPayload: string,
): Effect.Effect<McpOAuthStatePayload, AuthError> =>
  Effect.try({
    try: () => base64UrlDecodeText(encodedPayload),
    catch: invalidOAuthStateError,
  }).pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(EncodedMcpOAuthStatePayload)(json).pipe(
        Effect.mapError(invalidOAuthStateError),
      ),
    ),
  );

const oauthStateMatchesCallback = (
  payload: McpOAuthStatePayload,
  expected: {
    readonly expectedHostId: string;
    readonly expectedProvider: string;
  },
): boolean =>
  payload.hostId === expected.expectedHostId &&
  payload.provider === expected.expectedProvider &&
  Date.parse(payload.expiresAt) > Date.now();

const invalidOAuthStateError = (cause?: unknown): AuthError =>
  Option.fromNullishOr(cause).pipe(
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

    const maxLength = Math.max(
      actualBytes.byteLength,
      expectedBytes.byteLength,
    );
    let difference = actualBytes.byteLength ^ expectedBytes.byteLength;

    for (let index = 0; index < maxLength; index += 1) {
      difference |= (actualBytes[index] ?? 0) ^ (expectedBytes[index] ?? 0);
    }

    return lengthsMatch && difference === 0;
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
