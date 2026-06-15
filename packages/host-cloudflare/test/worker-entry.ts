import type { CodeModeRequest, CodeModeResponse } from "@ptools/code-mode-api";
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
  override call(request: CodeModeRequest): Promise<CodeModeResponse> {
    recordCodeModeObjectCall({
      hostId: this.ctx.id.name,
      request,
    });

    const failure = codeModeObjectTestFailure();

    return failure === undefined
      ? Promise.resolve(codeModeObjectTestResponse())
      : Promise.reject(failure);
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
