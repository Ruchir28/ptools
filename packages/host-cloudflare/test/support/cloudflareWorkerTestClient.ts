/// <reference path="../worker-env.d.ts" />

/** Shared HTTP client and binding helpers for local workerd integration tests. */
import { env, exports } from "cloudflare:workers";

export const publicAccessToken = "test-public-token";

export const handleRequest = async (
  pathOrUrl: string,
  options: {
    readonly method?: string;
    readonly headers?: HeadersInit;
    readonly body?: BodyInit;
  } = {},
): Promise<Response> => {
  const url = new URL(pathOrUrl, "https://ptools.example").toString();
  const request = new Request(url, requestInit(options));

  return exports.default.fetch(request);
};

const requestInit = (options: {
  readonly method?: string;
  readonly headers?: HeadersInit;
  readonly body?: BodyInit;
}): RequestInit => {
  const headers = jsonHeaders(options.headers, options.body);

  return {
    method: options.method ?? "GET",
    ...(headers === undefined ? {} : { headers }),
    ...(options.body === undefined ? {} : { body: options.body }),
  };
};

const jsonHeaders = (
  headers: HeadersInit | undefined,
  body: BodyInit | undefined,
): HeadersInit | undefined => {
  if (body === undefined) {
    return headers;
  }

  const result = new Headers(headers);
  if (!result.has("content-type")) {
    result.set("content-type", "application/json");
  }
  return result;
};

export const authHeaders = (): HeadersInit => ({
  Authorization: `Bearer ${publicAccessToken}`,
});

export const codeModeSearchProvidersBody = (): string =>
  JSON.stringify({ operation: "search_providers" });

export const configBody = (
  server: {
    readonly url?: string;
    readonly headers?: Record<string, string>;
  } = {},
): string =>
  JSON.stringify({
    config: {
      mcpServers: {
        example: {
          url: server.url ?? "https://mcp.example",
          ...(server.headers === undefined ? {} : { headers: server.headers }),
        },
      },
    },
  });

export const emptyConfigBody = (): string =>
  JSON.stringify({ config: { mcpServers: {} } });

export const configureHost = async (
  hostId: string,
  body: string,
): Promise<void> => {
  const response = await handleRequest(`/hosts/${hostId}/config`, {
    method: "PUT",
    headers: authHeaders(),
    body,
  });

  if (response.status !== 200) {
    throw new Error(`Host configuration failed with HTTP ${response.status}.`);
  }
};

export const secretsBody = (secrets: Record<string, string>): string =>
  JSON.stringify({ secrets });

export const mcpAuthStatusBody = (_origin?: string): string =>
  JSON.stringify({});

export const configureSecrets = async (
  hostId: string,
  secrets: Record<string, string>,
): Promise<void> => {
  const response = await handleRequest(`/hosts/${hostId}/secrets`, {
    method: "PUT",
    headers: authHeaders(),
    body: secretsBody(secrets),
  });

  if (response.status !== 200) {
    throw new Error(
      `Host secret configuration failed with HTTP ${response.status}.`,
    );
  }
};

export const configTestStub = (hostId: string) =>
  env.PTOOLS_CODE_MODE.getByName(hostId);

export const uniqueHostId = (): string => `test-${crypto.randomUUID()}`;
