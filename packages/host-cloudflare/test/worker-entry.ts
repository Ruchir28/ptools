import { parseCodeModeRequest, type CodeModeResponse } from "@ptools/code-mode-api";
import type { CodeModeObjectCallInput } from "../src/objects/codeModeObject/rpc.js";
import { ResolvedPtoolsConfig } from "@ptools/config";
import { Effect, Schema } from "effect";
import {
  CloudflareOAuthStatePayloadSchema,
  signOAuthState,
} from "../src/layers/auth.js";
import {
  CODE_MODE_OBJECT_CONFIG_BLOB_KEY,
  CODE_MODE_OBJECT_SECRET_KEY_PREFIX,
  StoredConfigBlob,
} from "../src/layers/config.js";
import { makeCodeModeObjectStorage } from "../src/layers/platform.js";
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
        error: cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
      };
    }
  }

  readConfigBlobForTest(): Promise<
    typeof StoredConfigBlob.Encoded | undefined
  > {
    return this.ctx.storage.get<typeof StoredConfigBlob.Encoded>(
      CODE_MODE_OBJECT_CONFIG_BLOB_KEY,
    );
  }

  writeConfigBlobForTest(blob: unknown): Promise<void> {
    return this.ctx.storage.put(CODE_MODE_OBJECT_CONFIG_BLOB_KEY, blob);
  }

  async readSecretsForTest(): Promise<Record<string, string>> {
    const stored = await this.ctx.storage.list<string>({
      prefix: CODE_MODE_OBJECT_SECRET_KEY_PREFIX,
    });
    const secrets: Record<string, string> = {};

    for (const [key, value] of stored) {
      secrets[key.slice(CODE_MODE_OBJECT_SECRET_KEY_PREFIX.length)] = value;
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
    payload: Parameters<typeof CloudflareOAuthStatePayloadSchema.make>[0],
  ): Promise<string> {
    return Effect.runPromise(
      signOAuthState({
        storage: makeCodeModeObjectStorage(this.ctx.storage),
        payload,
      }),
    );
  }
}

export default worker;
