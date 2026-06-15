/**
 * Durable Object storage key helpers for Cloudflare-hosted OAuth state and
 * credentials. These keys are host-local because they are stored inside the
 * named CodeModeObject(hostId) Durable Object.
 */

export const CODE_MODE_OBJECT_OAUTH_STATE_SECRET_KEY = "oauth/state-secret";
export const CODE_MODE_OBJECT_OAUTH_STATE_KEY_PREFIX = "oauth/state/";
export const CODE_MODE_OBJECT_CREDENTIAL_KEY_PREFIX = "credentials/";

export const codeModeObjectOAuthStateKey = (nonce: string): string =>
  `${CODE_MODE_OBJECT_OAUTH_STATE_KEY_PREFIX}${nonce}`;

export const codeModeObjectCredentialKey = (key: string): string =>
  `${CODE_MODE_OBJECT_CREDENTIAL_KEY_PREFIX}${key}`;

export const codeModeObjectCredentialClientKey = (serverName: string): string =>
  `${serverName}/client`;

export const codeModeObjectCredentialTokensKey = (serverName: string): string =>
  `${serverName}/tokens`;

export const codeModeObjectCredentialPkceVerifierKey = (
  serverName: string,
): string => `${serverName}/pkce-verifier`;

export const codeModeObjectCredentialDiscoveryKey = (
  serverName: string,
): string => `${serverName}/discovery`;
