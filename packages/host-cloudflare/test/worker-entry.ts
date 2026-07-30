import { McpOAuthStatePayload, McpOAuthStateStore } from "@ptools/auth";
import type { HostOperationRequest } from "@ptools/host-api";
import type {
  CloudflareHostOperationRpcInput,
  CloudflareHostOperationRpcResponse,
} from "../src/objects/codeModeObject/rpc.js";

import {
  CONFIGURED_HOST_CONFIG_BLOB_KEY,
  CONFIGURED_SECRET_VALUE_KEY_PREFIX,
  ConfiguredHostConfigBlob,
  HostSecretStorage,
  HostSecretStorageBackend,
} from "@ptools/config";
import { HostIdentityLayer } from "@ptools/host-context";
import { Effect, Layer } from "effect";
import { makeDurableObjectHostStorage } from "../src/layers/platform.js";
import { CodeModeObject } from "../src/objects/CodeModeObject.js";
import worker from "../src/worker/entry.js";
import { recordCodeModeObjectCall } from "./codeModeObjectTestState.js";

export class TestCodeModeObject extends CodeModeObject {
  override handleHostOperation(
    input: CloudflareHostOperationRpcInput,
  ): Promise<CloudflareHostOperationRpcResponse> {
    const request = input.request as HostOperationRequest;
    if (request.operation === "code_mode") {
      recordCodeModeObjectCall({
        hostId: this.ctx.id.name,
        request: request.input,
        origin: input.publicOrigin,
        caller: input.caller,
      });
    }
    return super.handleHostOperation(input);
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

  signOAuthStateForTest(
    payload: Parameters<typeof McpOAuthStatePayload.make>[0],
  ): Promise<string> {
    return Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* McpOAuthStateStore;
        return yield* store.sign({ payload });
      }).pipe(
        Effect.provide(
          McpOAuthStateStore.layer.pipe(
            Layer.provide(HostSecretStorage.layer),
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
