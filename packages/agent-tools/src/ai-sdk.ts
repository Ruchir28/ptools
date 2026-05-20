import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type {
  CodeModeToolName,
  PtoolsSession,
  ToolNameOptions,
} from "./types.js";

const CODE_MODE_TOOL_NAMES: ReadonlyArray<CodeModeToolName> = [
  "search",
  "get_tool_schema",
  "execute",
];

const SearchInputSchema = z.object({
  query: z.string().optional(),
});

const ToolSchemaInputSchema = z.object({
  tools: z
    .array(
      z.object({
        jsServerName: z.string().trim().min(1),
        jsToolName: z.string().trim().min(1),
      }),
    )
    .describe(
      "Selected tools from search whose full schemas and TypeScript declarations are needed.",
    ),
});

const EXECUTE_CODE_CONTRACT = [
  "code must be a JavaScript function expression that the executor can call.",
  "Prefer async arrow functions: async () => { ... }.",
  "Do not send a script body, top-level await, top-level return, or a function declaration.",
  "Provider namespaces returned by search, such as github, are injected as globals inside that function.",
].join(" ");

const ExecuteInputSchema = z.object({
  code: z.string().describe(EXECUTE_CODE_CONTRACT),
  timeoutMs: z
    .number()
    .optional()
    .describe("Optional per-run timeout override in milliseconds."),
});

export const toAISDKTools = (
  session: PtoolsSession,
  options: ToolNameOptions = {},
): ToolSet => {
  const reverseMap = new Map<string, CodeModeToolName>();

  for (const canonicalName of CODE_MODE_TOOL_NAMES) {
    reverseMap.set(toVisibleToolName(canonicalName, options), canonicalName);
  }

  const tools: ToolSet = {};

  for (const [visibleName, canonicalName] of reverseMap) {
    tools[visibleName] = makeAISDKTool(
      session,
      visibleName,
      canonicalName,
      reverseMap,
    );
  }

  return tools;
};

const toVisibleToolName = (
  name: CodeModeToolName,
  options: ToolNameOptions,
): string => {
  const prefix =
    options.toolNamePrefix === undefined ? "ptools_" : options.toolNamePrefix;

  return prefix === false ? name : `${prefix}${name}`;
};

const makeAISDKTool = (
  session: PtoolsSession,
  visibleName: string,
  canonicalName: CodeModeToolName,
  reverseMap: ReadonlyMap<string, CodeModeToolName>,
) => {
  const execute = (input: unknown): Promise<unknown> => {
    const mappedName = reverseMap.get(visibleName);

    if (mappedName === undefined) {
      throw new Error(`Unknown AI SDK ptools tool: ${visibleName}`);
    }

    return session.callCodeModeTool(mappedName, input);
  };

  switch (canonicalName) {
    case "search":
      return tool({
        description:
          "Enumerate available MCP-backed provider APIs. Call with no arguments first to list every provider and tool, then optionally pass a query to narrow results. Always start without a query so you know what providers exist before searching for specific terms.",
        inputSchema: SearchInputSchema,
        execute,
      });
    case "get_tool_schema":
      return tool({
        description:
          "Fetch full JSON schemas and TypeScript declaration snippets for selected ptools Code Mode tools before writing execute code.",
        inputSchema: ToolSchemaInputSchema,
        execute,
      });
    case "execute":
      return tool({
        description: `Run generated JavaScript against MCP-backed provider APIs discovered through search. ${EXECUTE_CODE_CONTRACT}`,
        inputSchema: ExecuteInputSchema,
        execute,
      });
  }
};
