import { resolve } from "node:path";
import {
  CodeMode,
  makeCodeModeLive,
} from "@ptools/code-mode";
import { parseCodeModeToolCall } from "@ptools/code-mode-api";
import { ConfigSource } from "@ptools/config";
import { makeLocalSandboxExecutorLive } from "@ptools/executor";
import {
  FileConfigSourceLive,
  NodeAuthCoordinatorLive,
  NodeCredentialsStoreLive,
  ProcessEnvSecretResolverLive,
} from "@ptools/host-node";
import { makeMcpRegistryLive } from "@ptools/mcp-registry";
import { Effect, Either, Layer, ManagedRuntime } from "effect";
import type {
  CodeModeToolName,
  CreatePtoolsSessionFromConfigFileOptions,
  CreatePtoolsSessionOptions,
  PtoolsSession,
} from "./types.js";

export const createPtoolsSession = async (
  options: CreatePtoolsSessionOptions,
): Promise<PtoolsSession> => {
  const live = makeCodeModeLive().pipe(
    Layer.provide(
      Layer.merge(
        makeMcpRegistryLive(options.mcpServers).pipe(
          Layer.provide(makeNodeAuthCoordinatorLive()),
        ),
        makeLocalSandboxExecutorLive(options.executor),
      ),
    ),
  );
  const runtime = ManagedRuntime.make(live);

  try {
    await runtime.runtime();
  } catch (cause) {
    await runtime.dispose();
    throw cause;
  }

  return makePtoolsSession(runtime);
};

export const loadPtoolsSessionConfig = async (
  path = "ptools.config.json",
  options: CreatePtoolsSessionFromConfigFileOptions = {},
): Promise<CreatePtoolsSessionOptions> => {
  const resolvedPath = resolve(options.cwd ?? process.cwd(), path);
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const source = yield* ConfigSource;

      return yield* source.load;
    }).pipe(
      Effect.provide(
        FileConfigSourceLive({ path: resolvedPath }).pipe(
          Layer.provide(
            ProcessEnvSecretResolverLive({
              env: options.env ?? process.env,
            }),
          ),
        ),
      ),
      Effect.either,
    ),
  );

  if (Either.isLeft(result)) {
    throw result.left;
  }

  return result.right;
};

export const createPtoolsSessionFromConfigFile = async (
  path?: string,
  options?: CreatePtoolsSessionFromConfigFileOptions,
): Promise<PtoolsSession> =>
  createPtoolsSession(await loadPtoolsSessionConfig(path, options));

export const makePtoolsSession = (
  runtime: ManagedRuntime.ManagedRuntime<CodeMode, unknown>,
): PtoolsSession => ({
  callCodeModeTool: (name, input) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const codeMode = yield* CodeMode;

        const request = yield* parseCodeModeToolCall(name, input);

        switch (request.operation) {
          case "search_providers":
            return yield* codeMode.searchProviders(request.input);
          case "search":
            return yield* codeMode.search(request.input);
          case "get_tool_schema":
            return yield* codeMode.toolSchema(request.input);
          case "execute":
            return yield* codeMode.execute(request.input);
          default:
            return yield* Effect.fail(
              new Error(`Unsupported Code Mode session operation: ${request}`),
            );
        }
      }),
    ),
  diagnostics: () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const codeMode = yield* CodeMode;

        return yield* codeMode.diagnostics;
      }),
    ),
  close: () => runtime.dispose(),
});

const makeNodeAuthCoordinatorLive = () =>
  NodeAuthCoordinatorLive({
    runtimeId: "local",
    autoOpen:
      process.env.PTOOLS_AUTH_AUTO_OPEN !== "0" &&
      process.env.PTOOLS_AUTH_AUTO_OPEN !== "false" &&
      process.stderr.isTTY === true,
  }).pipe(
    Layer.provide(
      NodeCredentialsStoreLive({
        serviceName: "ptools-mcp-oauth",
      }),
    ),
  );
