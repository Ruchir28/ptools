import { McpOAuthFlow } from "@ptools/auth";
import type { CodeModeResponse } from "@ptools/code-mode-api";
import { CodeModeServer } from "@ptools/code-mode-api/effect";
import {
  ResolvedPtoolsConfigSource,
  ServerConfigError,
  type ResolvedPtoolsConfig,
} from "@ptools/config";
import {
  ConfiguredHostContextError,
  ConfiguredHostContextRunner,
  HostStableRuntimeLayer,
  type ConfiguredHostOperationServices,
  type HostStableRuntimeServices,
} from "@ptools/host-runtime";
import { DurableObject } from "cloudflare:workers";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Option } from "effect";
import {
  CloudflareDynamicWorkerSandboxRuntimeLayer,
  makeCodeModeObjectWorkerLoader,
} from "../layers/executor/index.js";
import {
  CloudflareHttpMcpConnectorLayer,
  CloudflareMcpConnectorLayer,
} from "../layers/mcpConnector.js";
import {
  CodeModeObjectPlatformLayer,
  requireDurableObjectHostId,
} from "../layers/platform.js";
import type { PtoolsWorkerEnv } from "../worker/ingress.js";
import {
  ParsedCompleteMcpOAuthCallback,
  codeModeObjectMcpAuthErrorFromCause,
  finishMcpOAuthCallback,
  getMcpAuthStatus,
  parseCompleteMcpOAuthCallback,
  renderOAuthMessage,
  startMcpAuth,
} from "./codeModeObject/auth.js";
import {
  configureCodeModeObject,
  configureCodeModeObjectSecrets,
} from "./codeModeObject/config.js";
import type {
  CodeModeObjectCallInput,
  CodeModeObjectMcpAuthError,
  CompleteMcpOAuthCallbackInput,
  CompleteMcpOAuthCallbackResponse,
  ConfigureCodeModeObjectInput,
  ConfigureCodeModeObjectResponse,
  ConfigureCodeModeObjectSecretsInput,
  ConfigureCodeModeObjectSecretsResponse,
  GetMcpAuthStatusInput,
  GetMcpAuthStatusResponse,
  StartMcpAuthInput,
  StartMcpAuthResponse,
} from "./codeModeObject/rpc.js";

export type {
  CodeModeObjectCallInput,
  CodeModeObjectMcpAuthError,
  CodeModeObjectRpc,
  CompleteMcpOAuthCallbackInput,
  CompleteMcpOAuthCallbackResponse,
  CompleteMcpOAuthCallbackResult,
  ConfigureCodeModeObjectError,
  ConfigureCodeModeObjectInput,
  ConfigureCodeModeObjectResponse,
  ConfigureCodeModeObjectResult,
  ConfigureCodeModeObjectSecretsInput,
  ConfigureCodeModeObjectSecretsResponse,
  ConfigureCodeModeObjectSecretsResult,
  GetMcpAuthStatusInput,
  GetMcpAuthStatusResponse,
  StartMcpAuthInput,
  StartMcpAuthResponse,
} from "./codeModeObject/rpc.js";

type StableHostRuntime = ManagedRuntime.ManagedRuntime<
  HostStableRuntimeServices,
  unknown
>;

export class CodeModeObject extends DurableObject<PtoolsWorkerEnv> {
  readonly #hostId: string;
  readonly #stableRuntime: StableHostRuntime;

  constructor(ctx: DurableObjectState, env: PtoolsWorkerEnv) {
    super(ctx, env);

    this.#hostId = requireDurableObjectHostId(ctx);
    const cloudflarePlatformLayer = CodeModeObjectPlatformLayer({
      state: ctx,
      workerLoader: makeCodeModeObjectWorkerLoader(env.PTOOLS_EXECUTION_LOADER),
    });
    const cloudflarePrimitiveLayer = Layer.mergeAll(
      CloudflareMcpConnectorLayer.pipe(
        Layer.provide(CloudflareHttpMcpConnectorLayer),
      ),
      CloudflareDynamicWorkerSandboxRuntimeLayer,
    ).pipe(Layer.provideMerge(cloudflarePlatformLayer));

    this.#stableRuntime = ManagedRuntime.make(
      HostStableRuntimeLayer.pipe(Layer.provide(cloudflarePrimitiveLayer)),
    );
  }

  /** Run one schema-backed Code Mode request through the shared configured context. */
  call(input: CodeModeObjectCallInput): Promise<CodeModeResponse> {
    return this.runConfiguredHostOperation(
      input.origin,
      Effect.gen(function* () {
        const server = yield* CodeModeServer;
        return yield* server.handle(input.request);
      }),
    );
  }

  /** Persist host config through stable shared stores, then invalidate cached contexts. */
  configure(
    input: ConfigureCodeModeObjectInput,
  ): Promise<ConfigureCodeModeObjectResponse> {
    return this.runStableRpc(
      Effect.gen(function* () {
        const result = yield* configureCodeModeObject({
          rawConfigJson: input.rawConfigJson,
        });
        const contexts = yield* ConfiguredHostContextRunner;
        yield* contexts.invalidateAll;
        return result;
      }),
    );
  }

  /** Persist host secrets through stable shared stores, then invalidate cached contexts. */
  configureSecrets(
    input: ConfigureCodeModeObjectSecretsInput,
  ): Promise<ConfigureCodeModeObjectSecretsResponse> {
    return this.runStableRpc(
      Effect.gen(function* () {
        const result = yield* configureCodeModeObjectSecrets({
          rawSecretsJson: input.rawSecretsJson,
        });
        const contexts = yield* ConfiguredHostContextRunner;
        yield* contexts.invalidateAll;
        return result;
      }),
    );
  }

  mcpAuthStatus(
    input: GetMcpAuthStatusInput,
  ): Promise<GetMcpAuthStatusResponse> {
    return this.runHostMcpAuthRpc(input.origin, getMcpAuthStatus());
  }

  startMcpAuth(input: StartMcpAuthInput): Promise<StartMcpAuthResponse> {
    return this.runHostMcpAuthRpc(
      input.origin,
      startMcpAuth({
        serverName: input.serverName,
        force: Option.fromNullable(input.force).pipe(
          Option.getOrElse(() => false),
        ),
      }),
    );
  }

  /**
   * Verify OAuth callback state in the stable runtime, then start the configured
   * context only when a valid authorization code must be exchanged.
   */
  completeMcpOAuthCallback(
    input: CompleteMcpOAuthCallbackInput,
  ): Promise<CompleteMcpOAuthCallbackResponse> {
    return this.runStableRpc(
      parseCompleteMcpOAuthCallback({
        provider: input.provider,
        method: input.method,
        url: input.url,
        bodyText: Option.fromNullable(input.bodyText),
        expectedHostId: this.#hostId,
      }).pipe(
        Effect.flatMap(
          ParsedCompleteMcpOAuthCallback.$match({
            Complete: ({ result }) => Effect.succeed(result),
            Finish: (finish) =>
              this.runConfiguredHostOperationEffect(
                input.origin,
                finishMcpOAuthCallback(finish).pipe(
                  Effect.map(() => ({
                    status: 200,
                    headers: {
                      "content-type": "text/html; charset=utf-8",
                    },
                    body: renderOAuthMessage(
                      "Authorization complete",
                      `${finish.serverName} is connected. You can return to your MCP client and retry.`,
                    ),
                  })),
                ),
              ).pipe(Effect.mapError(codeModeObjectMcpAuthErrorFromCause)),
          }),
        ),
      ),
    );
  }

  protected loadResolvedConfig(): Effect.Effect<
    ResolvedPtoolsConfig,
    ServerConfigError
  > {
    const load = Effect.gen(function* () {
      const source = yield* ResolvedPtoolsConfigSource;
      return yield* source.load;
    }).pipe(Effect.provide(ResolvedPtoolsConfigSource.Default));

    return Effect.promise(() => this.#stableRuntime.runPromiseExit(load)).pipe(
      Effect.flatMap(
        Exit.match({
          onSuccess: Effect.succeed,
          onFailure: (cause) =>
            Cause.failureOption(cause).pipe(
              Option.match({
                onSome: (failure) =>
                  Effect.fail(
                    failure instanceof ServerConfigError
                      ? failure
                      : new ServerConfigError({
                          message: "Failed to load resolved host config.",
                          cause: failure,
                        }),
                  ),
                onNone: () =>
                  Effect.fail(
                    new ServerConfigError({
                      message: "Failed to load resolved host config.",
                      cause,
                    }),
                  ),
              }),
            ),
        }),
      ),
    );
  }

  private runConfiguredHostOperation<A, E>(
    origin: string,
    effect: Effect.Effect<A, E, ConfiguredHostOperationServices>,
  ): Promise<A> {
    return this.#stableRuntime.runPromise(
      this.runConfiguredHostOperationEffect(origin, effect),
    );
  }

  private runConfiguredHostOperationEffect<A, E>(
    origin: string,
    effect: Effect.Effect<A, E, ConfiguredHostOperationServices>,
  ): Effect.Effect<
    A,
    E | ConfiguredHostContextError,
    ConfiguredHostContextRunner
  > {
    return Effect.gen(function* () {
      const contexts = yield* ConfiguredHostContextRunner;
      return yield* contexts.run({ origin }, effect);
    });
  }

  private runHostMcpAuthRpc<A>(
    origin: string,
    effect: Effect.Effect<
      A,
      CodeModeObjectMcpAuthError,
      McpOAuthFlow | ConfiguredHostOperationServices
    >,
  ): Promise<
    | { readonly ok: true; readonly result: A }
    | { readonly ok: false; readonly error: CodeModeObjectMcpAuthError }
  > {
    return this.runStableRpc(
      this.runConfiguredHostOperationEffect(origin, effect).pipe(
        Effect.mapError(codeModeObjectMcpAuthErrorFromCause),
      ),
    );
  }

  private runStableRpc<A, E>(
    effect: Effect.Effect<A, E, HostStableRuntimeServices>,
  ): Promise<
    | { readonly ok: true; readonly result: A }
    | { readonly ok: false; readonly error: E }
  > {
    return this.#stableRuntime.runPromise(effect.pipe(toRpcResponse));
  }
}

const toRpcResponse = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<
  | { readonly ok: true; readonly result: A }
  | { readonly ok: false; readonly error: E },
  never,
  R
> =>
  Effect.match(effect, {
    onFailure: (error) => ({ ok: false as const, error }),
    onSuccess: (result) => ({ ok: true as const, result }),
  });
