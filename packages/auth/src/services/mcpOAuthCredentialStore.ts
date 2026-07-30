/**
 * Shared MCP OAuth credential persistence.
 *
 * Plain-English meaning of "MCP OAuth credential store": this is the shared
 * object that remembers long-lived OAuth data for one configured MCP server so
 * the user does not have to reauthorize on every request. The platform only
 * supplies an exact-key `HostSecretStorage` that is already scoped to one host.
 *
 * Example flow:
 *
 * ```txt
 * User authorizes MCP server "github" at https://mcp.example.com
 *   MCP SDK returns tokens, dynamic client info, and discovery metadata
 *   provider calls McpOAuthCredentialStore.setTokens(...)
 *
 * McpOAuthCredentialStore.layer
 *   writes exact logical keys derived from:
 *     serverName = "github"
 *     serverUrl  = "https://mcp.example.com"
 *     slot       = "tokens" | "client" | "pkce-verifier" | "discovery"
 *
 * Later request to the same MCP server
 *   provider calls getTokens / getClientInformation / getDiscoveryState
 *   store returns the saved values or Option.none for optional missing slots
 * ```
 *
 * This is intentionally separate from `McpOAuthStateStore`: credentials are
 * reusable, long-lived OAuth artifacts; state is a short-lived, single-use
 * browser callback nonce. Platforms should not construct credential keys, parse
 * credential JSON, or implement invalidation themselves.
 */
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { HostSecretStorage } from "@ptools/config";
import { Context, Effect, Layer, Option } from "effect";
import { CredentialError } from "../authErrors.js";

export interface McpOAuthCredentialIdentity {
  /** Runtime MCP server name from the resolved ptools config. */
  readonly serverName: string;
  /** MCP server URL/issuer identity used to avoid reusing credentials after URL changes. */
  readonly serverUrl: string;
}

export type McpOAuthCredentialInvalidationScope =
  /** Delete every persisted OAuth credential slot for this server identity. */
  | "all"
  /** Delete dynamic client registration information only. */
  | "client"
  /** Delete access/refresh tokens only. */
  | "tokens"
  /** Delete the PKCE verifier only. */
  | "verifier"
  /** Delete cached OAuth discovery metadata only. */
  | "discovery";

export interface McpOAuthCredentialStoreService {
  /** Load dynamic OAuth client registration info, if one was persisted. */
  readonly getClientInformation: (
    identity: McpOAuthCredentialIdentity,
  ) => Effect.Effect<
    Option.Option<OAuthClientInformationMixed>,
    CredentialError
  >;
  /** Persist dynamic OAuth client registration info returned by the MCP SDK. */
  readonly setClientInformation: (
    identity: McpOAuthCredentialIdentity,
    clientInformation: OAuthClientInformationMixed,
  ) => Effect.Effect<void, CredentialError>;
  /** Load stored OAuth tokens, if present. */
  readonly getTokens: (
    identity: McpOAuthCredentialIdentity,
  ) => Effect.Effect<Option.Option<OAuthTokens>, CredentialError>;
  /** Persist OAuth tokens after authorization or refresh. */
  readonly setTokens: (
    identity: McpOAuthCredentialIdentity,
    tokens: OAuthTokens,
  ) => Effect.Effect<void, CredentialError>;
  /** Load the PKCE verifier required to finish the current authorization flow. */
  readonly getCodeVerifier: (
    identity: McpOAuthCredentialIdentity,
  ) => Effect.Effect<string, CredentialError>;
  /** Persist the PKCE verifier created when authorization starts. */
  readonly setCodeVerifier: (
    identity: McpOAuthCredentialIdentity,
    codeVerifier: string,
  ) => Effect.Effect<void, CredentialError>;
  /** Load cached OAuth discovery metadata, if present. */
  readonly getDiscoveryState: (
    identity: McpOAuthCredentialIdentity,
  ) => Effect.Effect<Option.Option<OAuthDiscoveryState>, CredentialError>;
  /** Persist OAuth discovery metadata returned by the MCP SDK. */
  readonly setDiscoveryState: (
    identity: McpOAuthCredentialIdentity,
    state: OAuthDiscoveryState,
  ) => Effect.Effect<void, CredentialError>;
  /** Return true when reusable OAuth tokens are present for this server identity. */
  readonly hasStoredCredentials: (
    identity: McpOAuthCredentialIdentity,
  ) => Effect.Effect<boolean, CredentialError>;
  /** Delete one or more OAuth credential slots for reauthorization/recovery. */
  readonly invalidate: (
    identity: McpOAuthCredentialIdentity,
    scope: McpOAuthCredentialInvalidationScope,
  ) => Effect.Effect<void, CredentialError>;
}

/**
 * Shared OAuth credential store backed directly by host-scoped secret storage.
 *
 * This service owns long-lived MCP OAuth credential persistence. It is separate
 * from `McpOAuthStateStore`, which only handles short-lived browser callback
 * state/nonces. Platform providers call these semantic methods instead of
 * constructing credential keys, parsing JSON, or implementing invalidation.
 */
export class McpOAuthCredentialStore extends Context.Service<McpOAuthCredentialStore>()(
  "@ptools/McpOAuthCredentialStore",
  {
    make: Effect.gen(function* () {
      const storage = yield* HostSecretStorage;

      // JSON-backed slots all share the same read behavior: missing is valid
      // absence, but malformed stored JSON is a credential error.
      const getOptionalJson = <Value>(
        identity: McpOAuthCredentialIdentity,
        slot: McpOAuthCredentialSlot,
      ): Effect.Effect<Option.Option<Value>, CredentialError> => {
        const key = credentialSlotKey(identity, slot);

        return storage.get(key).pipe(
          Effect.mapError(
            (cause) =>
              new CredentialError({
                message: `Failed to read MCP OAuth ${slot} credential for ${identity.serverName}.`,
                cause,
              }),
          ),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeedNone,
              onSome: (value) =>
                Effect.try({
                  try: () => JSON.parse(value) as Value,
                  catch: (cause) =>
                    new CredentialError({
                      message: `Failed to parse MCP OAuth ${slot} credential for ${identity.serverName}.`,
                      cause,
                    }),
                }).pipe(Effect.map(Option.some)),
            }),
          ),
        );
      };

      // JSON-backed slots all share the same write behavior so platform
      // providers cannot drift on encoding details.
      const setJson = (
        identity: McpOAuthCredentialIdentity,
        slot: McpOAuthCredentialSlot,
        value: unknown,
      ): Effect.Effect<void, CredentialError> =>
        storage
          .put(credentialSlotKey(identity, slot), JSON.stringify(value))
          .pipe(
            Effect.mapError(
              (cause) =>
                new CredentialError({
                  message: `Failed to write MCP OAuth ${slot} credential for ${identity.serverName}.`,
                  cause,
                }),
            ),
          );

      const deleteSlot = (
        identity: McpOAuthCredentialIdentity,
        slot: McpOAuthCredentialSlot,
      ): Effect.Effect<void, CredentialError> =>
        storage.delete(credentialSlotKey(identity, slot)).pipe(
          Effect.mapError(
            (cause) =>
              new CredentialError({
                message: `Failed to delete MCP OAuth ${slot} credential for ${identity.serverName}.`,
                cause,
              }),
          ),
        );

      return {
        getClientInformation: (identity) => getOptionalJson(identity, "client"),
        setClientInformation: (identity, clientInformation) =>
          setJson(identity, "client", clientInformation),
        getTokens: (identity) => getOptionalJson(identity, "tokens"),
        setTokens: (identity, tokens) => setJson(identity, "tokens", tokens),
        getCodeVerifier: (identity) =>
          storage.get(credentialSlotKey(identity, "pkce-verifier")).pipe(
            Effect.mapError(
              (cause) =>
                new CredentialError({
                  message: `Failed to read MCP OAuth PKCE verifier for ${identity.serverName}.`,
                  cause,
                }),
            ),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new CredentialError({
                      message: `Missing OAuth PKCE verifier for ${identity.serverName}. Restart authorization from ptools.`,
                    }),
                  ),
                onSome: Effect.succeed,
              }),
            ),
          ),
        setCodeVerifier: (identity, codeVerifier) =>
          storage
            .put(credentialSlotKey(identity, "pkce-verifier"), codeVerifier)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new CredentialError({
                    message: `Failed to write MCP OAuth PKCE verifier for ${identity.serverName}.`,
                    cause,
                  }),
              ),
            ),
        getDiscoveryState: (identity) => getOptionalJson(identity, "discovery"),
        setDiscoveryState: (identity, state) =>
          setJson(identity, "discovery", state),
        hasStoredCredentials: (identity) =>
          getOptionalJson<OAuthTokens>(identity, "tokens").pipe(
            Effect.map(Option.isSome),
          ),
        invalidate: (identity, scope) =>
          Effect.all([
            scope === "all" || scope === "tokens"
              ? deleteSlot(identity, "tokens")
              : Effect.void,
            scope === "all" || scope === "client"
              ? deleteSlot(identity, "client")
              : Effect.void,
            scope === "all" || scope === "verifier"
              ? deleteSlot(identity, "pkce-verifier")
              : Effect.void,
            scope === "all" || scope === "discovery"
              ? deleteSlot(identity, "discovery")
              : Effect.void,
          ]).pipe(Effect.asVoid),
      } satisfies McpOAuthCredentialStoreService;
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}

export type McpOAuthCredentialSlot =
  | "client"
  | "tokens"
  | "pkce-verifier"
  | "discovery";

/** Prefix for logical MCP OAuth credential keys inside HostSecretStorage. */

const MCP_OAUTH_CREDENTIAL_KEY_PREFIX = "mcp-oauth/";

/**
 * Build the exact logical key for one credential slot.
 *
 * The key includes server name and a hash of server URL. If a configured server
 * changes URL, old tokens/client registrations are not accidentally reused for
 * a different OAuth issuer. Physical host scoping still belongs to the provided
 * HostSecretStorage implementation.
 */
export const mcpOAuthCredentialKey = (
  identity: McpOAuthCredentialIdentity,
  slot: McpOAuthCredentialSlot,
): string =>
  `${MCP_OAUTH_CREDENTIAL_KEY_PREFIX}${encodeURIComponent(identity.serverName)}/${hashKey(identity.serverUrl)}/${slot}`;

const credentialSlotKey = (
  identity: McpOAuthCredentialIdentity,
  slot: McpOAuthCredentialSlot,
): string => mcpOAuthCredentialKey(identity, slot);

const hashKey = (value: string): string => {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash.toString(16);
};
