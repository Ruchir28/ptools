import { resolve } from "node:path";
import {
  CodeMode,
  type CodeModeExecuteRequest,
  type CodeModeSearchProvidersRequest,
  type CodeModeSearchRequest,
  type CodeModeToolSchemaRequest,
  makeCodeModeLive,
} from "@ptools/code-mode";
import { ConfigSource } from "@ptools/config";
import { makeLocalSandboxExecutorLive } from "@ptools/executor";
import {
  FileConfigSourceLive,
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
        makeMcpRegistryLive(options.mcpServers),
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

        switch (name as CodeModeToolName | string) {
          case "search_providers":
            return yield* codeMode.searchProviders(
              parseSearchProvidersInput(input),
            );
          case "search":
            return yield* codeMode.search(parseSearchInput(input));
          case "get_tool_schema":
            return yield* codeMode.toolSchema(parseToolSchemaInput(input));
          case "execute":
            return yield* codeMode.execute(parseExecuteInput(input));
          default:
            return yield* Effect.fail(
              new Error(`Unknown Code Mode tool: ${String(name)}`),
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

const parseSearchProvidersInput = (
  input: unknown,
): CodeModeSearchProvidersRequest => {
  if (input === undefined) {
    return {};
  }

  const value = expectRecord(input, "search_providers input");

  if (value.query !== undefined && typeof value.query !== "string") {
    throw new TypeError(
      "search_providers.query must be a string when provided",
    );
  }

  if (value.limit !== undefined && !isPositiveInteger(value.limit)) {
    throw new TypeError(
      "search_providers.limit must be a positive integer when provided",
    );
  }

  return {
    ...(value.query === undefined ? {} : { query: value.query }),
    ...(value.limit === undefined ? {} : { limit: value.limit }),
  };
};

const parseSearchInput = (input: unknown): CodeModeSearchRequest => {
  const value = expectRecord(input, "search input");

  if (typeof value.query !== "string" || value.query.trim() === "") {
    throw new TypeError("search.query must be a non-blank string");
  }

  if (value.provider !== undefined && typeof value.provider !== "string") {
    throw new TypeError("search.provider must be a string when provided");
  }

  if (value.limit !== undefined && !isPositiveInteger(value.limit)) {
    throw new TypeError(
      "search.limit must be a positive integer when provided",
    );
  }

  return {
    query: value.query,
    ...(value.provider === undefined ? {} : { provider: value.provider }),
    ...(value.limit === undefined ? {} : { limit: value.limit }),
  };
};

const parseToolSchemaInput = (input: unknown): CodeModeToolSchemaRequest => {
  const value = expectRecord(input, "get_tool_schema input");

  if (value.toolIds !== undefined && !Array.isArray(value.toolIds)) {
    throw new TypeError("get_tool_schema.toolIds must be an array");
  }

  if (value.tools !== undefined && !Array.isArray(value.tools)) {
    throw new TypeError("get_tool_schema.tools must be an array");
  }

  if (value.toolIds === undefined && value.tools === undefined) {
    throw new TypeError(
      "get_tool_schema requires toolIds or tools to be provided",
    );
  }

  return {
    ...(value.toolIds === undefined
      ? {}
      : {
          toolIds: value.toolIds.map((toolId, index) => {
            if (typeof toolId !== "string" || toolId.trim() === "") {
              throw new TypeError(
                `get_tool_schema.toolIds[${index}] must be a non-blank string`,
              );
            }

            return toolId;
          }),
        }),
    ...(value.tools === undefined
      ? {}
      : {
          tools: value.tools.map((tool, index) => {
            const selected = expectRecord(
              tool,
              `get_tool_schema.tools[${index}]`,
            );

            if (typeof selected.jsServerName !== "string") {
              throw new TypeError(
                `get_tool_schema.tools[${index}].jsServerName must be a string`,
              );
            }

            if (typeof selected.jsToolName !== "string") {
              throw new TypeError(
                `get_tool_schema.tools[${index}].jsToolName must be a string`,
              );
            }

            return {
              jsServerName: selected.jsServerName,
              jsToolName: selected.jsToolName,
            };
          }),
        }),
  };
};

const parseExecuteInput = (input: unknown): CodeModeExecuteRequest => {
  const value = expectRecord(input, "execute input");

  if (typeof value.code !== "string") {
    throw new TypeError("execute.code must be a string");
  }

  if (value.timeoutMs !== undefined && typeof value.timeoutMs !== "number") {
    throw new TypeError("execute.timeoutMs must be a number when provided");
  }

  return value.timeoutMs === undefined
    ? { code: value.code }
    : { code: value.code, timeoutMs: value.timeoutMs };
};

const expectRecord = (
  value: unknown,
  label: string,
): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }

  return value as Record<string, unknown>;
};

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;
