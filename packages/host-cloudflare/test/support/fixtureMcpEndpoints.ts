/** Shared URLs and deterministic credentials for the local MCP/OAuth fixture. */
export const FIXTURE_MCP_PORT = 19719;
export const FIXTURE_MCP_ORIGIN = `http://127.0.0.1:${FIXTURE_MCP_PORT}`;

export const PUBLIC_MCP_PATH = "/mcp/public";
export const STATIC_BEARER_MCP_PATH = "/mcp/static-bearer-protected";
export const OAUTH_PROTECTED_MCP_PATH = "/mcp/oauth-protected";

export const PUBLIC_MCP_URL = `${FIXTURE_MCP_ORIGIN}${PUBLIC_MCP_PATH}`;
export const STATIC_BEARER_MCP_URL = `${FIXTURE_MCP_ORIGIN}${STATIC_BEARER_MCP_PATH}`;
export const OAUTH_PROTECTED_MCP_URL = `${FIXTURE_MCP_ORIGIN}${OAUTH_PROTECTED_MCP_PATH}`;

export const OAUTH_PROTECTED_RESOURCE_METADATA_PATH =
  "/.well-known/oauth-protected-resource/mcp/oauth-protected";
export const OAUTH_AUTHORIZATION_SERVER_METADATA_PATH =
  "/.well-known/oauth-authorization-server";
export const OAUTH_AUTHORIZE_PATH = "/authorize";
export const OAUTH_TOKEN_PATH = "/token";

export const FIXTURE_STATIC_BEARER_TOKEN = "resolved-test-token";
export const FIXTURE_OAUTH_AUTHORIZATION_CODE = "fixture-code";
export const FIXTURE_OAUTH_ACCESS_TOKEN = "fixture-access-token";
