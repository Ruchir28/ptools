import type { CodeModeRequest, CodeModeResponse } from "@ptools/code-mode-api";
import type { ResolvedPtoolsConfig } from "@ptools/config";
import { Effect } from "effect";
import {
  CODE_MODE_OBJECT_CONFIG_BLOB_KEY,
  CODE_MODE_OBJECT_SECRET_KEY_PREFIX,
  type StoredConfigBlob,
} from "../src/layers/config.js";
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

  readConfigBlobForTest(): Promise<StoredConfigBlob | undefined> {
    return this.ctx.storage.get<StoredConfigBlob>(
      CODE_MODE_OBJECT_CONFIG_BLOB_KEY,
    );
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
    | { readonly ok: true; readonly config: ResolvedPtoolsConfig }
    | { readonly ok: false; readonly message: string }
  > {
    return Effect.runPromise(
      this.loadResolvedConfig().pipe(
        Effect.match({
          onFailure: (error) => ({
            ok: false as const,
            message: error.message,
          }),
          onSuccess: (config) => ({
            ok: true as const,
            config,
          }),
        }),
      ),
    );
  }
}

export default worker;
