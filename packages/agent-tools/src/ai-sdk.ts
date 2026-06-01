import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type {
  CodeModeToolName,
  PtoolsSession,
  ToolNameOptions,
} from "./types.js";

const CODE_MODE_TOOL_NAMES: ReadonlyArray<CodeModeToolName> = [
  "search_providers",
  "search",
  "get_tool_schema",
  "execute",
];

const SearchProvidersInputSchema = z.object({
  query: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

const SearchInputSchema = z.object({
  query: z.string().trim().min(1),
  provider: z.string().trim().min(1).optional(),
  limit: z.number().int().positive().optional(),
});

const ToolSchemaInputSchema = z.object({
  toolIds: z
    .array(z.string().trim().min(1))
    .describe(
      "Preferred copy-safe tool IDs returned by search, such as github.create_issue.",
    ),
});

const EXECUTE_CODE_CONTRACT = [
  "code must be a JavaScript function expression that the executor can call.",
  "Prefer async arrow functions: async () => { ... }.",
  "Do not send a script body, top-level await, top-level return, or a function declaration.",
  "Provider namespaces returned by search, such as github, are injected as globals inside that function.",
  "Use execute to keep intermediate provider results, filtering, joins, pagination, aggregation, and field extraction inside the code run; return only the compact result needed for the user.",
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
    case "search_providers":
      return tool({
        description:
          'Find configured upstream MCP provider namespaces behind this single ptools surface. Call with {} to see available providers, or with { query: "..." } when the task mentions a source or capability and you are unsure which provider owns it. Use a returned provider value to narrow ptools_search when helpful.',
        inputSchema: SearchProvidersInputSchema,
        execute,
      });
    case "search":
      return tool({
        description:
          'Find MCP-backed actions for a task. This is action discovery; use ptools_search_providers first when you need to discover which upstream providers are available. Call with { query: "..." }, optionally with { provider: "..." } to narrow. A good next step is ptools_get_tool_schema for selected action.toolId values before ptools_execute.',
        inputSchema: SearchInputSchema,
        execute,
      });
    case "get_tool_schema":
      return tool({
        description:
          "Fetch full JSON schemas and TypeScript declaration snippets for selected ptools Code Mode actions before writing execute code. Prefer a small set of toolIds returned by ptools_search that you actually plan to call, then use ptools_execute to combine tool calls and reduce intermediate results.",
        inputSchema: ToolSchemaInputSchema,
        execute,
      });
    case "execute":
      return tool({
        description: `Run generated JavaScript against MCP-backed provider APIs discovered through search. This is the best place for multi-step provider calls, result inspection, filtering, aggregation, joins, and extracting the few fields needed for the final answer. ${EXECUTE_CODE_CONTRACT}`,
        inputSchema: ExecuteInputSchema,
        execute,
      });
  }
};
