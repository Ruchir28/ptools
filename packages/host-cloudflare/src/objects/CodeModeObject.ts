import { CodeModeServer, type CodeModeResponse } from "@ptools/code-mode-api";
import { AuthCoordinator } from "@ptools/auth";
import {
  ConfigSource,
  ServerConfigError,
  type ResolvedPtoolsConfig,
} from "@ptools/config";
import { DurableObject } from "cloudflare:workers";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { CloudflareOAuthFlow } from "../layers/auth.js";
import {
  DurableObjectConfigSourceLayer,
  DurableObjectSecretResolverLayer,
} from "../layers/config.js";
import { CloudflareCodeModeRuntimeLayer } from "../layers/codeModeRuntime.js";
import {
  CodeModeObjectIdentity,
  CodeModeObjectPlatformLayer,
  CodeModeObjectRequestOriginLayer,
  CodeModeObjectStorage,
  makeCodeModeObjectStorage,
} from "../layers/platform.js";
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

type HostRuntime = ManagedRuntime.ManagedRuntime<
  CodeModeServer | AuthCoordinator | CloudflareOAuthFlow | ConfigSource,
  unknown
>;

interface CachedHostRuntime {
  readonly origin: string;
  readonly runtime: HostRuntime;
}

export class CodeModeObject extends DurableObject<PtoolsWorkerEnv> {
  /**
   * Platform services are passive values owned by this Durable Object instance.
   *
   * The storage and Worker Loader adapters are constructed once in the
   * constructor and wrapped with `Layer.succeed`. In Effect, `Layer.succeed`
   * captures the already-created value; providing this layer into a later
   * `ManagedRuntime` does not call the adapter constructors again. By contrast,
   * `Layer.effect` / `Layer.scoped` services are built by the runtime and are
   * memoized by that runtime's `MemoMap`.
   *
   * This means each origin-specific host runtime receives the same stable
   * Durable Object platform values, while config/auth/MCP/Code Mode services
   * built with effectful layers are rebuilt when the cached ManagedRuntime is
   * replaced. A separate platform ManagedRuntime or shared MemoMap would only be
   * needed if these platform services later acquire scoped resources, start
   * background fibers, or require runtime-specific configuration.
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

  /**
   * Serves one schema-backed Code Mode request through the configured host
   * runtime for this Durable Object and public request origin.
   *
   * The Worker already handled HTTP auth, JSON parsing, and origin derivation.
   * This method crosses the Durable Object RPC boundary, selects the cached
   * origin-aware ManagedRuntime, and delegates operation dispatch to
   * CodeModeServer inside that runtime.
   *
   * Per request this only looks up services already registered in that runtime's
   * Effect `Context`; it does not construct a new CodeModeServer, reload config,
   * or rebuild MCP/executor layers. Those are created once when
   * `#createHostRuntime` materializes `CloudflareCodeModeServerLayer` and cached
   * until the origin changes or `configure` / `configureSecrets` disposes the
   * runtime.
   */
  call(input: CodeModeObjectCallInput): Promise<CodeModeResponse> {
    return this.runInHostRuntime(
      input.origin,
      Effect.gen(function* () {
        // Context lookup for the service built by CloudflareCodeModeServerLayer
        // during ManagedRuntime startup, not a per-request server initialization.
        const server = yield* CodeModeServer;

        return yield* server.handle(input.request);
      }),
    );
  }

  /**
   * Stores a new unresolved host config using only stable platform services.
   *
   * This intentionally does not run inside `#hostRuntime`. The configured host
   * runtime is built from the config stored by this method, so requiring that
   * runtime here would create a circular dependency and would also risk using
   * stale config. The workflow only needs Durable Object storage from
   * `#platformLayer`, then disposes any cached runtime so the next runtime-backed
   * operation rebuilds from the newly stored config.
   */
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

  /**
   * Stores per-host secrets using only stable platform services.
   *
   * Like `configure(...)`, this is a one-off `Effect.runPromise` workflow, not a
   * call through the cached `ManagedRuntime`. It only needs
   * `CodeModeObjectStorage` from `#platformLayer` to write `secrets/<name>`
   * values. After the write, the cached runtime is disposed because its
   * `ConfigSource` may already have resolved old secret values; the next
   * Code Mode/auth operation will build a fresh runtime and resolve secrets from
   * storage again.
   */
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

  /**
   * Runs operations that need the configured host graph.
   *
   * Use this path for behavior that depends on loaded config, resolved secrets,
   * OAuth/auth state, MCP connections, or Code Mode runtime services. Unlike the
   * setup methods above, this goes through the cached origin-aware
   * `ManagedRuntime`, whose layer graph is built from persisted config plus the
   * stable `#platformLayer` and request-derived origin.
   *
   * Effects passed here may `yield*` any of the runtime's exported services
   * (`CodeModeServer`, `AuthCoordinator`, `CloudflareOAuthFlow`, `ConfigSource`).
   * Those tags resolve against the runtime `Context` built in
   * `#createHostRuntime`; `runtime.runPromise` does not re-run layer construction
   * on each call unless the cached runtime was disposed and recreated.
   */
  private async runInHostRuntime<A, E>(
    origin: string,
    effect: Effect.Effect<
      A,
      E,
      CodeModeServer | AuthCoordinator | CloudflareOAuthFlow | ConfigSource
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

  /**
   * Materializes the configured host layer graph once and caches the resulting
   * `ManagedRuntime` for this origin.
   *
   * `runtime.runtime()` is where Effect builds services such as `ConfigSource`,
   * `AuthCoordinator`, internal `CodeMode`, and `CodeModeServer`. Later RPC
   * handlers only look those services up from the runtime context.
   */
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

  /**
   * Builds the configured host runtime layer for one public request origin.
   *
   * `#platformLayer` is not a separate runtime. It is a stable set of
   * `Layer.succeed` services constructed once from Durable Object `ctx/env` and
   * then provided into this runtime graph. `CodeModeObjectRequestOriginLayer` is
   * rebuilt per origin because OAuth URLs and auth-provider behavior can depend
   * on the public origin that reached the Worker.
   */
  private hostRuntimeLayer(
    origin: string,
  ): Layer.Layer<
    CodeModeServer | AuthCoordinator | CloudflareOAuthFlow | ConfigSource,
    unknown
  > {
    const requestOrigin = CodeModeObjectRequestOriginLayer(origin);

    // The host runtime is the only cached ManagedRuntime because these services
    // contain config-derived state. The stable platform values are supplied as
    // inputs, while request origin is kept separate because it is not an
    // intrinsic Durable Object identity. The cache records the origin used to
    // construct these URL-producing services and is rebuilt before serving a
    // request from a different origin.
    return CloudflareCodeModeRuntimeLayer.pipe(
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

  /**
   * Clears and disposes the cached configured runtime after persisted inputs
   * change.
   *
   * Config and secret setup methods run outside `#hostRuntime`, but they mutate
   * storage read by that runtime's `ConfigSource`, `SecretResolver`, auth, and
   * MCP services. Disposing here is what connects those one-off storage writes
   * to the next runtime-backed request: the next call rebuilds the ManagedRuntime
   * from current Durable Object storage instead of reusing stale services.
   */
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
