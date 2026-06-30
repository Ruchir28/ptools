/** Effect-native HTTP client for named Host HTTP API endpoints. */
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform";
import {
  CodeModeInvalidRequestError,
  CodeModeRemoteError,
  CodeModeTransportError,
  type CodeModeClientError,
} from "@ptools/code-mode-api";
import {
  CodeModeRequest,
  CodeModeResponse,
} from "@ptools/code-mode-api/contracts";
import { CodeModeClient } from "@ptools/code-mode-api/effect";
import { Context, Data, Effect, Layer, Redacted, Schema } from "effect";
import {
  ConfigureHostInput,
  ConfigureHostResponse,
  ConfigureHostSecretsInput,
  ConfigureHostSecretsResponse,
  HostCodeModeResponse,
  HostMcpAuthStatusResponse,
  StartHostMcpAuthResponse,
} from "../contracts/index.js";

export interface HostHttpClientOptions {
  readonly baseUrl: string;
  readonly hostId: string;
  readonly accessToken: Redacted.Redacted<string>;
}

export interface StartMcpAuthClientInput {
  readonly serverName: string;
  readonly force?: boolean | undefined;
}

export class HostHttpClientError extends Data.TaggedError(
  "HostHttpClientError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Endpoint-shaped client for the shared Host HTTP API. */
export class HostHttpClient extends Context.Tag("@ptools/HostHttpClient")<
  HostHttpClient,
  {
    readonly codeMode: (
      request: CodeModeRequest,
    ) => Effect.Effect<HostCodeModeResponse, HostHttpClientError>;
    readonly configure: (
      input: ConfigureHostInput,
    ) => Effect.Effect<ConfigureHostResponse, HostHttpClientError>;
    readonly configureSecrets: (
      input: ConfigureHostSecretsInput,
    ) => Effect.Effect<ConfigureHostSecretsResponse, HostHttpClientError>;
    readonly mcpAuthStatus: () => Effect.Effect<
      HostMcpAuthStatusResponse,
      HostHttpClientError
    >;
    readonly startMcpAuth: (
      input: StartMcpAuthClientInput,
    ) => Effect.Effect<StartHostMcpAuthResponse, HostHttpClientError>;
  }
>() {}

/**
 * Shared HTTP implementation; platform assemblies must provide HttpClient.
 *
 * Keep concrete fetch/WebHandler choices outside this layer. Cloudflare/browser
 * clients can provide `FetchHttpClient.layer`, Node can provide the selected
 * `@effect/platform-node` or fetch-backed client layer, and embedded SDKs can
 * provide a custom `HttpClient` whose `execute` calls the shared Web handler.
 */
export const HostHttpClientLive = (
  options: HostHttpClientOptions,
): Layer.Layer<HostHttpClient, never, HttpClient.HttpClient> =>
  Layer.effect(
    HostHttpClient,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const baseUrl = new URL(options.baseUrl);

      const requestJson = <A>(input: {
        readonly method: "POST" | "PUT";
        readonly path: string;
        readonly payload: unknown;
        // The response schemas have heterogeneous encoded/input types. The
        // client only decodes response bodies, so this helper intentionally
        // accepts any encoded input shape while preserving the decoded `A`.
        readonly response: Schema.Schema<A, any, never>;
      }): Effect.Effect<A, HostHttpClientError> => {
        const request = HttpClientRequest.make(input.method)(
          new URL(input.path, baseUrl).toString(),
        ).pipe(
          HttpClientRequest.bearerToken(options.accessToken),
          HttpClientRequest.acceptJson,
        );

        return HttpClientRequest.bodyJson(request, input.payload).pipe(
          Effect.flatMap((requestWithBody) => http.execute(requestWithBody)),
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(input.response)),
          Effect.mapError(toHostHttpClientError),
        );
      };

      const hostPath = (suffix: string) =>
        `/hosts/${encodeURIComponent(options.hostId)}${suffix}`;

      return {
        codeMode: (payload) =>
          requestJson({
            method: "POST",
            path: hostPath("/code-mode"),
            payload,
            response: HostCodeModeResponse,
          }),

        configure: (payload) =>
          requestJson({
            method: "PUT",
            path: hostPath("/config"),
            payload,
            response: ConfigureHostResponse,
          }),

        configureSecrets: (payload) =>
          requestJson({
            method: "PUT",
            path: hostPath("/secrets"),
            payload,
            response: ConfigureHostSecretsResponse,
          }),

        mcpAuthStatus: () =>
          requestJson({
            method: "POST",
            path: hostPath("/auth/status"),
            payload: {},
            response: HostMcpAuthStatusResponse,
          }),

        startMcpAuth: ({ serverName, force }) =>
          requestJson({
            method: "POST",
            path: hostPath(`/auth/${encodeURIComponent(serverName)}`),
            payload: { force },
            response: StartHostMcpAuthResponse,
          }),
      };
    }),
  );

/**
 * Derive the focused CodeModeClient consumed by agent-facing packages.
 *
 * The Host HTTP endpoint keeps the normal host operation envelope so HTTP 200
 * represents "the operation ran" and `result.ok` carries the domain outcome.
 * This focused adapter is the consumer boundary that unwraps `code_mode` into
 * the inner `CodeModeResponse` expected by agent-tools and mcp-server.
 */
export const CodeModeClientFromHostHttpClientLive: Layer.Layer<
  CodeModeClient,
  never,
  HostHttpClient
> = Layer.effect(
  CodeModeClient,
  Effect.gen(function* () {
    const host = yield* HostHttpClient;

    return {
      call: (request) =>
        host.codeMode(request).pipe(
          Effect.mapError(toCodeModeClientTransportError),
          Effect.flatMap(unwrapHostCodeModeResponse),
        ),
    };
  }),
);

const toHostHttpClientError = (cause: unknown): HostHttpClientError =>
  new HostHttpClientError({
    message: "Host HTTP request failed.",
    cause,
  });

const unwrapHostCodeModeResponse = (
  response: HostCodeModeResponse,
): Effect.Effect<CodeModeResponse, CodeModeClientError> => {
  if (response.result.ok) {
    return Effect.succeed(response.result.response);
  }

  switch (response.result.error.code) {
    case "invalid_code_mode_request":
      return Effect.fail(
        new CodeModeInvalidRequestError({
          message: response.result.error.message,
          cause: response.result.error,
        }),
      );
    case "code_mode_server_failure":
      return Effect.fail(
        new CodeModeRemoteError({
          message: response.result.error.message,
          cause: response.result.error,
        }),
      );
  }
};

const toCodeModeClientTransportError = (
  cause: HostHttpClientError,
): CodeModeClientError =>
  new CodeModeTransportError({
    message: "Host HTTP client failed while calling Code Mode.",
    cause,
  });
