/**
 * Wire contract for Worker -> CodeModeObject Durable Object RPC.
 *
 * Types here describe what crosses Cloudflare's serialization boundary:
 * plain JSON-friendly inputs/outputs and `{ ok, result | error }` responses.
 * They intentionally exclude Effect, Option, and other in-DO domain values.
 *
 * - Caller: `src/worker/codeModeObjectRpc.ts` types `namespace.getByName(hostId)`
 *   as `CodeModeObjectRpc`.
 * - Implementer: `CodeModeObject` exposes matching public methods and converts
 *   to/from internal Effect programs at that boundary.
 */
import type { CodeModeRequest, CodeModeResponse } from "@ptools/code-mode-api";
import type { McpAuthStatus } from "@ptools/auth";

export interface ConfigureCodeModeObjectInput {
  readonly rawConfigJson: string;
}

export interface ConfigureCodeModeObjectResult {
  readonly hostId: string;
  readonly serverCount: number;
  readonly updatedAt: string;
}

export interface ConfigureCodeModeObjectSecretsInput {
  readonly rawSecretsJson: string;
}

export interface ConfigureCodeModeObjectSecretsResult {
  readonly hostId: string;
  readonly secretCount: number;
  readonly updatedAt: string;
}

export interface ConfigureCodeModeObjectError {
  readonly code:
    | "invalid_config"
    | "invalid_secrets"
    | "unsupported_config"
    | "config_storage_unavailable";
  readonly message: string;
}

export type ConfigureCodeModeObjectResponse =
  | {
      readonly ok: true;
      readonly result: ConfigureCodeModeObjectResult;
    }
  | {
      readonly ok: false;
      readonly error: ConfigureCodeModeObjectError;
    };

export type ConfigureCodeModeObjectSecretsResponse =
  | {
      readonly ok: true;
      readonly result: ConfigureCodeModeObjectSecretsResult;
    }
  | {
      readonly ok: false;
      readonly error: ConfigureCodeModeObjectError;
    };

export interface GetMcpAuthStatusInput {
  readonly origin: string;
}

export interface CodeModeObjectMcpAuthError {
  readonly code:
    | "invalid_config"
    | "auth_unavailable"
    | "invalid_oauth_callback"
    | "oauth_failed";
  readonly message: string;
}

export type GetMcpAuthStatusResponse =
  | {
      readonly ok: true;
      readonly result: McpAuthStatus;
    }
  | {
      readonly ok: false;
      readonly error: CodeModeObjectMcpAuthError;
    };

export interface StartMcpAuthInput {
  readonly origin: string;
  readonly serverName: string;
  readonly force?: boolean;
}

export type StartMcpAuthResponse =
  | {
      readonly ok: true;
      readonly result: { readonly authorizeUrl: string };
    }
  | {
      readonly ok: false;
      readonly error: CodeModeObjectMcpAuthError;
    };

export interface CompleteMcpOAuthCallbackInput {
  readonly origin: string;
  readonly provider: string;
  readonly method: string;
  readonly url: string;
  readonly bodyText?: string;
}

export interface CompleteMcpOAuthCallbackResult {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body: string;
}

export type CompleteMcpOAuthCallbackResponse =
  | {
      readonly ok: true;
      readonly result: CompleteMcpOAuthCallbackResult;
    }
  | {
      readonly ok: false;
      readonly error: CodeModeObjectMcpAuthError;
    };

/**
 * Callable surface of a `CodeModeObject(hostId)` stub.
 *
 * This is not implemented directly as a class. `CodeModeObject` provides these
 * methods, and the Worker invokes them through
 * `env.PTOOLS_CODE_MODE.getByName(hostId)` instead of `stub.fetch(...)`.
 */
export interface CodeModeObjectRpc {
  readonly call: (request: CodeModeRequest) => Promise<CodeModeResponse>;
  readonly configure: (
    input: ConfigureCodeModeObjectInput,
  ) => Promise<ConfigureCodeModeObjectResponse>;
  readonly configureSecrets: (
    input: ConfigureCodeModeObjectSecretsInput,
  ) => Promise<ConfigureCodeModeObjectSecretsResponse>;
  readonly mcpAuthStatus: (
    input: GetMcpAuthStatusInput,
  ) => Promise<GetMcpAuthStatusResponse>;
  readonly startMcpAuth: (
    input: StartMcpAuthInput,
  ) => Promise<StartMcpAuthResponse>;
  readonly completeMcpOAuthCallback: (
    input: CompleteMcpOAuthCallbackInput,
  ) => Promise<CompleteMcpOAuthCallbackResponse>;
}
