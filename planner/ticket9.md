# Ticket 9: Agent Tool Library With AI SDK Code Mode Adapter

## Summary

Add a new `@ptools/agent-tools` package that lets users connect configured MCP
servers once, then adapt the resulting ptools Code Mode surface into a Vercel
AI SDK `ToolSet`.

V1 only supports the AI SDK adapter. Raw OpenAI, raw Anthropic, LangChain,
Mastra, and direct one-tool-per-MCP-tool adapters are follow-ups.

The intended starter API:

```ts
import { generateText, stepCountIs } from "ai";
import { openai } from "@ai-sdk/openai";
import { createPtoolsSession } from "@ptools/agent-tools";
import { toAISDKTools } from "@ptools/agent-tools/ai-sdk";

const ptools = await createPtoolsSession({ mcpServers });

try {
  const tools = toAISDKTools(ptools);

  const result = await generateText({
    model: openai("gpt-5.4"),
    tools,
    stopWhen: stepCountIs(8),
    prompt: "Find recent GitHub issues about auth and summarize them",
  });
} finally {
  await ptools.close();
}
```

V1 exposes only the ptools Code Mode tools:

```txt
search
get_tool_schema
execute
```

It does not expose one agent tool per upstream MCP tool. Code Mode remains the
model-facing product surface, and the AI SDK adapter is only a formatting layer
around it.

## Problem

Vercel AI SDK already provides a provider abstraction over OpenAI, Anthropic,
Google, and other model providers. For this first ticket, ptools should produce
AI SDK tools and let AI SDK handle provider-specific model/tool formatting.

The MCP registry and Code Mode logic should stay independent from the AI SDK
adapter. Users should create one ptools session and explicitly convert it into
AI SDK tools.

Avoid this shape:

```ts
ptools.aiSdk.tools;
```

That makes adapters look pre-mounted, encourages unnecessary dependency
coupling, and becomes awkward when raw OpenAI, Anthropic, LangChain, or Mastra
adapters are added later.

Prefer this shape:

```ts
const ptools = await createPtoolsSession({ mcpServers });
const tools = toAISDKTools(ptools);
```

This matches common library patterns: one lifecycle client/session, then
explicit conversion into the tool shape required by the user's harness.

## Desired Public API

### Core Package

Package:

```txt
@ptools/agent-tools
```

Exports:

```ts
export { createPtoolsSession } from "./session.js";

export type {
  CodeModeToolName,
  CreatePtoolsSessionOptions,
  PtoolsSession,
  ToolNameOptions,
} from "./types.js";
```

Core session shape:

```ts
type CodeModeToolName = "search" | "get_tool_schema" | "execute";

interface PtoolsSession {
  readonly callCodeModeTool: (
    name: CodeModeToolName,
    input: unknown,
  ) => Promise<unknown>;

  readonly diagnostics: () => Promise<ReadonlyArray<CodeModeDiagnostic>>;
  readonly close: () => Promise<void>;
}
```

Session factory:

```ts
const ptools = await createPtoolsSession({
  mcpServers,
  executor,
});
```

`mcpServers` should use the same resolved config shape currently consumed by
`makeMcpRegistryLive`. Do not add config-file loading in this ticket.

### AI SDK Adapter

Subpath export:

```txt
@ptools/agent-tools/ai-sdk
```

Public API:

```ts
export const toAISDKTools = (
  session: PtoolsSession,
  options?: ToolNameOptions,
) => ToolSet;
```

Naming options:

```ts
interface ToolNameOptions {
  readonly toolNamePrefix?: string | false;
}
```

Default public names:

```txt
ptools_search
ptools_get_tool_schema
ptools_execute
```

With `toolNamePrefix: false`:

```txt
search
get_tool_schema
execute
```

Custom prefixes are allowed:

```ts
toAISDKTools(ptools, { toolNamePrefix: "mcp_" });
```

which exposes:

```txt
mcp_search
mcp_get_tool_schema
mcp_execute
```

The adapter must maintain a reverse mapping from AI SDK-visible names back to
canonical Code Mode names.

## AI SDK Behavior

Return an AI SDK `ToolSet` object for `generateText` / `streamText`.

Use AI SDK `tool(...)`, not `dynamicTool(...)`, because the three Code Mode tool
contracts are stable.

Use stable Zod input schemas for:

- `search`
- `get_tool_schema`
- `execute`

Each tool's `execute` calls:

```ts
session.callCodeModeTool(canonicalName, input);
```

AI SDK owns the tool-call loop. Users pass the returned `ToolSet` to
`generateText` or `streamText`; when the model calls a ptools tool, AI SDK calls
the tool's `execute` function and feeds the result back to the model.

If Code Mode fails, the AI SDK adapter should throw from `execute`. AI SDK will
surface that as a tool execution error according to its normal behavior. Do not
silently turn internal errors into successful output strings in v1.

## Tool Contracts

All adapters expose the same three stable contracts.

### `search`

Input:

```ts
{
  query?: string;
}
```

Execution:

```ts
session.callCodeModeTool("search", input);
```

Description should tell the model this is the first discovery step and returns
schema-free summaries of MCP-backed provider APIs.

### `get_tool_schema`

Input:

```ts
{
  tools: ReadonlyArray<{
    jsServerName: string;
    jsToolName: string;
  }>;
}
```

Execution:

```ts
session.callCodeModeTool("get_tool_schema", input);
```

Description should tell the model to call this for selected tools before
writing `execute` code.

### `execute`

Input:

```ts
{
  code: string;
  timeoutMs?: number;
}
```

Execution:

```ts
session.callCodeModeTool("execute", input);
```

Description must preserve the existing Code Mode contract:

- `code` must be a JavaScript function expression.
- Prefer `async () => { ... }`.
- Do not send a script body, top-level `await`, top-level `return`, or a
  function declaration.
- Provider namespaces returned by `search`, such as `github`, are injected as
  globals inside that function.

## Implementation Notes

### Package Setup

Add:

```txt
packages/agent-tools
```

with the same package conventions as the other workspace packages:

- ESM
- `exports` map
- `tsconfig.json`
- `tsconfig.test.json` if tests are outside `src`
- `build`, `typecheck`, and `test` scripts

Subpath exports for v1:

```jsonc
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./ai-sdk": {
      "types": "./dist/ai-sdk.d.ts",
      "default": "./dist/ai-sdk.js"
    }
  }
}
```

### Session Construction

`createPtoolsSession` should:

- build the existing `McpRegistry`, `LocalSandboxExecutor`, and `CodeMode`
  layers
- create a long-lived Effect runtime with `ManagedRuntime.make(layer)`
- expose Promise-based methods for app ergonomics
- call `runtime.dispose()` from `session.close()`

The session should own lifecycle. The AI SDK adapter should not own MCP clients,
executor processes, or scopes.

### Dependencies

- Core package code should not require AI SDK at runtime.
- The AI SDK adapter may depend on `ai` and `zod`.
- Do not add OpenAI SDK or Anthropic SDK dependencies in this ticket.

### Error Behavior

- Unknown AI SDK-visible tool names should fail clearly.
- Code Mode errors should propagate by throwing from the AI SDK tool `execute`
  function.
- Do not hide MCP registry/schema/dispatch failures with permissive fallback
  values.

## Tests

### Core Session

- `callCodeModeTool("search", input)` routes to `CodeMode.search`.
- `callCodeModeTool("get_tool_schema", input)` routes to `CodeMode.toolSchema`.
- `callCodeModeTool("execute", input)` routes to `CodeMode.execute`.
- Unknown tool names fail clearly.
- `diagnostics()` returns Code Mode diagnostics.
- `close()` releases the underlying Effect scope.

### AI SDK Adapter

- Adapter returns exactly three tools with default prefixed names.
- `toolNamePrefix: false` exposes exact names.
- Custom prefixes expose custom names and preserve reverse mapping.
- Each AI SDK tool `execute` calls the expected canonical Code Mode tool.
- Code Mode failures throw from the AI SDK tool `execute`.

### Integration

Use the existing fixture MCP server to prove one real vertical slice through the
AI SDK adapter:

```txt
createPtoolsSession
  -> toAISDKTools
  -> search
  -> get_tool_schema
  -> execute code calling fixture provider
  -> fixture MCP tool receives original MCP call
```

## Verification

Before considering this ticket complete, run:

```bash
pnpm --filter @ptools/agent-tools test
pnpm --filter @ptools/agent-tools typecheck
pnpm typecheck
pnpm build
```

If registry behavior is touched, also run:

```bash
pnpm --filter @ptools/mcp-registry test
```

## Future Follow-Ups

Raw provider adapters should be added after the AI SDK slice is working.

### OpenAI Responses

Future shape:

```ts
const openaiTools = toOpenAIResponsesTools(ptools);

let response = await client.responses.create({
  model,
  input,
  tools: openaiTools.tools,
});

const toolOutputs = [];

for (const item of response.output) {
  if (item.type === "function_call") {
    toolOutputs.push(await openaiTools.handleToolCall(item));
  }
}

if (toolOutputs.length > 0) {
  response = await client.responses.create({
    model,
    previous_response_id: response.id,
    input: toolOutputs,
    tools: openaiTools.tools,
  });
}
```

OpenAI arguments arrive as a JSON string. The future adapter should parse that
string and return a provider-ready `function_call_output`.

### Anthropic Messages

Future shape:

```ts
const anthropicTools = toAnthropicTools(ptools);

const message = await anthropic.messages.create({
  model,
  messages,
  tools: anthropicTools.tools,
});

const toolResults = [];

for (const block of message.content) {
  if (block.type === "tool_use") {
    toolResults.push(await anthropicTools.handleToolUse(block));
  }
}

if (toolResults.length > 0) {
  const nextMessage = await anthropic.messages.create({
    model,
    tools: anthropicTools.tools,
    messages: [
      ...messages,
      { role: "assistant", content: message.content },
      { role: "user", content: toolResults },
    ],
  });
}
```

Anthropic input is already parsed. The future adapter should return a
provider-ready `tool_result` block.

## Out Of Scope

- Raw OpenAI Responses adapter.
- Raw Anthropic Messages adapter.
- Direct one-agent-tool-per-upstream-MCP-tool adapters.
- LangChain, Mastra, OpenAI Agents SDK, LlamaIndex, or Composio adapters.
- Config path loading in `@ptools/agent-tools`.
- Remote hosted MCP deployment.
- Approval/governance policy.
- Tool search beyond the existing Code Mode `search`.

## Assumptions

- V1 supports AI SDK only.
- Users create one `PtoolsSession` and explicitly call `toAISDKTools`.
- The managed factory accepts resolved `mcpServers` config, not a config file
  path.
- Code Mode remains the product surface; the AI SDK adapter is a formatting
  layer around it.
