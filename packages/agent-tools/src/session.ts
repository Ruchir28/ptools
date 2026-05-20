import {
  CodeMode,
  type CodeModeExecuteRequest,
  type CodeModeSearchRequest,
  type CodeModeToolSchemaRequest,
  makeCodeModeLive,
} from "@ptools/code-mode";
import { makeLocalSandboxExecutorLive } from "@ptools/executor";
import { makeMcpRegistryLive } from "@ptools/mcp-registry";
import { Effect, Layer, ManagedRuntime } from "effect";
import type {
  CodeModeToolName,
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

export const makePtoolsSession = (
  runtime: ManagedRuntime.ManagedRuntime<CodeMode, unknown>,
): PtoolsSession => ({
  callCodeModeTool: (name, input) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const codeMode = yield* CodeMode;

        switch (name as CodeModeToolName | string) {
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

const parseSearchInput = (input: unknown): CodeModeSearchRequest => {
  if (input === undefined) {
    return {};
  }

  const value = expectRecord(input, "search input");

  if (value.query !== undefined && typeof value.query !== "string") {
    throw new TypeError("search.query must be a string when provided");
  }

  return value.query === undefined ? {} : { query: value.query };
};

const parseToolSchemaInput = (input: unknown): CodeModeToolSchemaRequest => {
  const value = expectRecord(input, "get_tool_schema input");

  if (!Array.isArray(value.tools)) {
    throw new TypeError("get_tool_schema.tools must be an array");
  }

  return {
    tools: value.tools.map((tool, index) => {
      const selected = expectRecord(tool, `get_tool_schema.tools[${index}]`);

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
