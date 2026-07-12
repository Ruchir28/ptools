import {
  parseCodeModeRequest,
  type CodeModeResponse,
} from "@ptools/code-mode-api";
import { McpOAuthStatePayload, McpOAuthStateStore } from "@ptools/auth";
import type { CodeModeObjectCallInput } from "../src/objects/codeModeObject/rpc.js";
import {
  CONFIGURED_HOST_CONFIG_BLOB_KEY,
  CONFIGURED_SECRET_VALUE_KEY_PREFIX,
  ConfiguredHostConfigBlob,
  HostSecretStorage,
  HostSecretStorageBackend,
  ResolvedPtoolsConfig,
} from "@ptools/config";
import { HostIdentityLayer } from "@ptools/host-context";
import { Effect, Layer, Schema } from "effect";
import { makeDurableObjectHostStorage } from "../src/layers/platform.js";
import { CodeModeObject } from "../src/objects/CodeModeObject.js";
import worker from "../src/worker/entry.js";
import {
  codeModeObjectTestFailure,
  codeModeObjectTestResponse,
  recordCodeModeObjectCall,
} from "./codeModeObjectTestState.js";

export class TestCodeModeObject extends CodeModeObject {
  override call(input: CodeModeObjectCallInput): Promise<CodeModeResponse> {
    recordCodeModeObjectCall({
      hostId: this.ctx.id.name,
      request: input.request,
      origin: input.origin,
    });

    const failure = codeModeObjectTestFailure();

    return failure === undefined
      ? Promise.resolve(codeModeObjectTestResponse())
      : Promise.reject(failure);
  }

  callRealCodeModeRuntimeForTest(
    input: CodeModeObjectCallInput,
  ): Promise<CodeModeResponse> {
    return super.call(input);
  }

  callRealCodeModeRuntimeFromUnknownForTest(input: {
    readonly origin: string;
    readonly request: unknown;
  }): Promise<CodeModeResponse> {
    return Effect.runPromise(
      parseCodeModeRequest(input.request).pipe(
        Effect.flatMap((request) =>
          Effect.promise(() => super.call({ origin: input.origin, request })),
        ),
      ),
    );
  }

  async callRealCodeModeRuntimeResultForTest(input: {
    readonly origin: string;
    readonly request: unknown;
  }): Promise<
    | { readonly ok: true; readonly result: CodeModeResponse }
    | { readonly ok: false; readonly error: string }
  > {
    try {
      return {
        ok: true,
        result: await this.callRealCodeModeRuntimeFromUnknownForTest(input),
      };
    } catch (cause) {
      return {
        ok: false,
        error:
          cause instanceof Error
            ? (cause.stack ?? cause.message)
            : String(cause),
      };
    }
  }

  async readConfigBlobForTest(): Promise<
    typeof ConfiguredHostConfigBlob.Encoded | undefined
  > {
    const raw = await this.ctx.storage.get<string>(
      CONFIGURED_HOST_CONFIG_BLOB_KEY,
    );

    return raw === undefined
      ? undefined
      : (JSON.parse(raw) as typeof ConfiguredHostConfigBlob.Encoded);
  }

  writeConfigBlobForTest(blob: unknown): Promise<void> {
    return this.ctx.storage.put(
      CONFIGURED_HOST_CONFIG_BLOB_KEY,
      JSON.stringify(blob),
    );
  }

  async readSecretsForTest(): Promise<Record<string, string>> {
    const stored = await this.ctx.storage.list<string>({
      prefix: CONFIGURED_SECRET_VALUE_KEY_PREFIX,
    });
    const secrets: Record<string, string> = {};

    for (const [key, value] of stored) {
      secrets[
        decodeURIComponent(key.slice(CONFIGURED_SECRET_VALUE_KEY_PREFIX.length))
      ] = value;
    }

    return secrets;
  }

  loadResolvedConfigResultForTest(): Promise<
    | {
        readonly ok: true;
        readonly config: typeof ResolvedPtoolsConfig.Encoded;
      }
    | { readonly ok: false; readonly message: string }
  > {
    return Effect.runPromise(
      this.loadResolvedConfig().pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.succeed({
              ok: false as const,
              message: error.message,
            }),
          onSuccess: (config) =>
            Schema.encode(ResolvedPtoolsConfig)(config).pipe(
              Effect.orDie,
              Effect.map((config) => ({ ok: true as const, config })),
            ),
        }),
      ),
    );
  }

  signOAuthStateForTest(
    payload: Parameters<typeof McpOAuthStatePayload.make>[0],
  ): Promise<string> {
    return Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* McpOAuthStateStore;
        return yield* store.sign({ payload });
      }).pipe(
        Effect.provide(
          McpOAuthStateStore.Default.pipe(
            Layer.provide(HostSecretStorage.Default),
            Layer.provide(
              Layer.merge(
                HostIdentityLayer(this.ctx.id.name ?? "test-host"),
                Layer.succeed(HostSecretStorageBackend, {
                  forHost: () =>
                    Effect.succeed(
                      makeDurableObjectHostStorage(this.ctx.storage, "secret"),
                    ),
                }),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

export default worker;
