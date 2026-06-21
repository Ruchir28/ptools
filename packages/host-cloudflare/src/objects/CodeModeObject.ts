import type { CodeModeRequest, CodeModeResponse } from "@ptools/code-mode-api";
import { AuthCoordinator } from "@ptools/auth";
import {
  ConfigSource,
  ServerConfigError,
  type ResolvedPtoolsConfig,
} from "@ptools/config";
import { DurableObject } from "cloudflare:workers";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import {
  CloudflareOAuthFlow,
  CodeModeObjectIdentity,
  CodeModeObjectPlatformLayer,
  CodeModeObjectRequestOriginLayer,
  CodeModeObjectStorage,
  DurableObjectAuthLayer,
  DurableObjectConfigSourceLayer,
  DurableObjectCredentialsStoreLayer,
  DurableObjectSecretResolverLayer,
  makeCodeModeObjectStorage,
} from "../layers/index.js";
import {
  makeCodeModeObjectWorkerLoader,
  type CodeModeObjectWorkerLoader,
} from "../layers/executor/workerLoaderService.js";
import type { PtoolsWorkerEnv } from "../worker/ingress.js";
import {
  ParsedCompleteMcpOAuthCallback,
  codeModeObjectMcpAuthErrorFromCause,
  finishMcpOAuthCallback,
  getMcpAuthStatus,
  initializeConfiguredMcpAuth,
  parseCompleteMcpOAuthCallback,
  renderOAuthMessage,
  startMcpAuth,
} from "./codeModeObject/auth.js";
import {
  configureCodeModeObject,
  configureCodeModeObjectSecrets,
} from "./codeModeObject/config.js";
import type {
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

type HostRuntime = ManagedRuntime.ManagedRuntime<
  AuthCoordinator | CloudflareOAuthFlow | ConfigSource,
  never
>;

interface CachedHostRuntime {
  readonly origin: string;
  readonly runtime: HostRuntime;
}

export class CodeModeObject extends DurableObject<PtoolsWorkerEnv> {
  /**
   * Platform services are passive values owned by this Durable Object instance.
   *
   * The storage adapter is constructed once here and this same Layer.succeed
   * graph is provided to pre-config workflows and the config-dependent host
   * runtime. A separate platform ManagedRuntime or shared MemoMap would only be
   * needed if these services later acquire scoped resources, start background
   * fibers, or require runtime-specific configuration.
   */
  readonly #platformLayer: Layer.Layer<
    CodeModeObjectStorage | CodeModeObjectIdentity | CodeModeObjectWorkerLoader
  >;

  #hostRuntime: Option.Option<CachedHostRuntime> = Option.none();

  constructor(ctx: DurableObjectState, env: PtoolsWorkerEnv) {
    super(ctx, env);

    this.#platformLayer = CodeModeObjectPlatformLayer({
      storage: makeCodeModeObjectStorage(ctx.storage),
      hostId: requireHostId(ctx),
      workerLoader: makeCodeModeObjectWorkerLoader(env.PTOOLS_EXECUTION_LOADER),
    });
  }

  call(_request: CodeModeRequest): Promise<CodeModeResponse> {
    return Effect.runPromise(
      Effect.die(
        new Error("CodeModeObject runtime is implemented in the next task"),
      ),
    );
  }

  configure(
    input: ConfigureCodeModeObjectInput,
  ): Promise<ConfigureCodeModeObjectResponse> {
    return Effect.runPromise(
      Effect.gen(this, function* () {
        const result = yield* configureCodeModeObject({
          rawConfigJson: input.rawConfigJson,
        });
        yield* this.disposeHostRuntimeEffect();

        return result;
      }).pipe(Effect.provide(this.#platformLayer), toRpcResponse),
    );
  }

  configureSecrets(
    input: ConfigureCodeModeObjectSecretsInput,
  ): Promise<ConfigureCodeModeObjectSecretsResponse> {
    return Effect.runPromise(
      Effect.gen(this, function* () {
        const result = yield* configureCodeModeObjectSecrets({
          rawSecretsJson: input.rawSecretsJson,
        });
        yield* this.disposeHostRuntimeEffect();

        return result;
      }).pipe(Effect.provide(this.#platformLayer), toRpcResponse),
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
   * Handles the browser redirect after an upstream MCP OAuth provider
   * authorizes a server. The Worker forwards the raw callback request here;
   * this method returns an HTML page the user sees in the browser.
   *
   * The flow is split into two phases:
   * 1. Parse + verify state (platform layer only) — cheap early exit for bad
   *    callbacks or provider-side errors.
   * 2. Exchange code for tokens (full host runtime) — only when state is valid
   *    and the provider returned an authorization code.
   */
  completeMcpOAuthCallback(
    input: CompleteMcpOAuthCallbackInput,
  ): Promise<CompleteMcpOAuthCallbackResponse> {
    return Effect.runPromise(
      // Phase 1: parse callback params and verify/consume the OAuth state nonce.
      parseCompleteMcpOAuthCallback({
        provider: input.provider,
        method: input.method,
        url: input.url,
        bodyText: Option.fromNullable(input.bodyText),
      }).pipe(
        Effect.provide(this.#platformLayer),
        Effect.flatMap(
          ParsedCompleteMcpOAuthCallback.$match({
            // Provider returned ?error=... — HTML response is already built.
            Complete: ({ result }) => Effect.succeed(result),
            // Valid code + state — exchange the code and render a success page.
            Finish: (finish) =>
              Effect.tryPromise({
                try: () =>
                  this.runInHostRuntime(
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
                  ),
                catch: codeModeObjectMcpAuthErrorFromCause,
              }),
          }),
        ),
        toRpcResponse,
      ),
    );
  }

  protected loadResolvedConfig(): Effect.Effect<
    ResolvedPtoolsConfig,
    ServerConfigError
  > {
    return Effect.gen(function* () {
      const source = yield* ConfigSource;

      return yield* source.load;
    }).pipe(
      Effect.provide(
        this.configLayer().pipe(Layer.provide(this.#platformLayer)),
      ),
    );
  }

  private async runInHostRuntime<A, E>(
    origin: string,
    effect: Effect.Effect<
      A,
      E,
      AuthCoordinator | CloudflareOAuthFlow | ConfigSource
    >,
  ): Promise<A> {
    const runtime = await this.getOrCreateHostRuntime(origin);

    return runtime.runPromise(effect);
  }

  private runHostMcpAuthRpc<A>(
    origin: string,
    effect: Effect.Effect<
      A,
      CodeModeObjectMcpAuthError,
      AuthCoordinator | CloudflareOAuthFlow | ConfigSource
    >,
  ): Promise<
    | { readonly ok: true; readonly result: A }
    | { readonly ok: false; readonly error: CodeModeObjectMcpAuthError }
  > {
    return Effect.runPromise(
      Effect.tryPromise({
        try: () => this.runInHostRuntime(origin, effect),
        catch: codeModeObjectMcpAuthErrorFromCause,
      }).pipe(toRpcResponse),
    );
  }

  private getOrCreateHostRuntime(origin: string): Promise<HostRuntime> {
    return Option.match(this.#hostRuntime, {
      onNone: () => this.createHostRuntime(origin),
      onSome: (cached) =>
        cached.origin === origin
          ? Promise.resolve(cached.runtime)
          : this.replaceHostRuntime(cached, origin),
    });
  }

  private async createHostRuntime(origin: string): Promise<HostRuntime> {
    const runtime = ManagedRuntime.make(this.hostRuntimeLayer(origin));

    try {
      await runtime.runtime();
      await runtime.runPromise(initializeConfiguredMcpAuth());
      this.#hostRuntime = Option.some({ origin, runtime });
      return runtime;
    } catch (cause) {
      await runtime.dispose();
      throw cause;
    }
  }

  private async replaceHostRuntime(
    cached: CachedHostRuntime,
    origin: string,
  ): Promise<HostRuntime> {
    this.#hostRuntime = Option.none();
    await cached.runtime.dispose();

    return this.createHostRuntime(origin);
  }

  private hostRuntimeLayer(
    origin: string,
  ): Layer.Layer<AuthCoordinator | CloudflareOAuthFlow | ConfigSource> {
    const requestOrigin = CodeModeObjectRequestOriginLayer(origin);
    const credentials = DurableObjectCredentialsStoreLayer;
    const auth = DurableObjectAuthLayer.pipe(Layer.provide(credentials));
    const config = this.configLayer();

    // The host runtime is the only cached ManagedRuntime because these services
    // contain config-derived state. The stable platform values are supplied as
    // inputs, while request origin is kept separate because it is not an
    // intrinsic Durable Object identity. The cache records the origin used to
    // construct these URL-producing services and is rebuilt before serving a
    // request from a different origin.
    return Layer.merge(auth, config).pipe(
      Layer.provide(this.#platformLayer),
      Layer.provide(requestOrigin),
    );
  }

  private configLayer(): Layer.Layer<
    ConfigSource,
    never,
    CodeModeObjectStorage | CodeModeObjectIdentity
  > {
    return DurableObjectConfigSourceLayer.pipe(
      Layer.provide(DurableObjectSecretResolverLayer),
    );
  }

  private disposeHostRuntimeEffect(): Effect.Effect<void> {
    const runtime = this.#hostRuntime;
    this.#hostRuntime = Option.none();

    return Option.match(runtime, {
      onNone: () => Effect.void,
      onSome: (cached) => Effect.promise(() => cached.runtime.dispose()),
    });
  }
}

const requireHostId = (ctx: DurableObjectState): string =>
  Option.fromNullable(ctx.id.name).pipe(
    Option.getOrThrowWith(
      () => new Error("CodeModeObject must be addressed by name."),
    ),
  );

const toRpcResponse = <A, E>(
  effect: Effect.Effect<A, E>,
): Effect.Effect<
  | { readonly ok: true; readonly result: A }
  | { readonly ok: false; readonly error: E }
> =>
  Effect.match(effect, {
    onFailure: (error) => ({ ok: false as const, error }),
    onSuccess: (result) => ({ ok: true as const, result }),
  });
