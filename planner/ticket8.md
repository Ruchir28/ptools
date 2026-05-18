# Ticket 8: Two-Stage Tool Discovery With On-Demand Schemas

## Summary

Change Code Mode discovery from returning every tool schema in `search()` to a two-stage model-facing flow:

```txt
search({ query })
  -> returns matching servers/tools with names, titles, descriptions, annotations, and diagnostics
  -> no full input/output schemas

getToolSchema({ tools })
  -> returns exact input/output schemas for selected tools
  -> returns generated TypeScript declarations grouped by requested server

execute({ code })
  -> unchanged runtime dispatch through host-backed provider APIs
```

This keeps discovery subtle and cheaper for the model. The model can first search by intent, inspect lightweight tool descriptions, then ask for the schema only for the tools it actually plans to call.

## Problem

Current `search()` returns both tool metadata and generated declarations for the matching surface. This is useful, but it can be noisy when many upstream MCP servers expose many tools:

- large schemas dominate the context before the model has chosen a tool
- broad or blank search can return declarations for tools that are never used
- the model has less room to reason about which provider/tool is relevant
- schema-heavy responses make the combined MCP server feel more like a dump than a search interface

The better product shape is progressive disclosure:

```txt
discover candidates
  -> select likely tool or tools
  -> fetch exact contracts in one batched request
  -> execute generated JavaScript
```

## Desired Model-Facing API

### `search`

Keep `search` as the primary discovery tool, but make its payload lightweight.

Return:

- upstream server name
- sanitized JS provider namespace
- original MCP tool name
- sanitized JS tool function name
- title
- description
- annotations, if useful and not huge
- schema availability/status flags
- registry diagnostics

Do not return:

- full `inputSchema`
- full `outputSchema`
- full TypeScript declaration bundle

Potential shape:

```ts
interface CodeModeSearchResult {
  readonly servers: ReadonlyArray<CodeModeServerSummary>;
  readonly diagnostics: ReadonlyArray<CodeModeDiagnostic>;
}

interface CodeModeServerSummary {
  readonly serverName: string;
  readonly jsServerName: string;
  readonly tools: ReadonlyArray<CodeModeToolSummary>;
}

interface CodeModeToolSummary {
  readonly originalToolName: string;
  readonly jsToolName: string;
  readonly title?: string;
  readonly description?: string;
  readonly annotations?: unknown;
  readonly hasInputSchema: boolean;
  readonly hasOutputSchema: boolean;
  readonly outputSchemaInvalid?: true;
}
```

### `get_tool_schema`

Add a new model-facing MCP tool for fetching schemas/declarations for one or more selected tools.

```txt
get_tool_schema
```

Use `get_tool_schema` instead of `tool_schema`. `search` and `execute` are action-oriented public tools, and `get_tool_schema` is less ambiguous than `tool_schema` or `inspect`.

Input should identify sandbox-visible tool boundaries, because those are what generated code calls:

```ts
interface GetToolSchemaRequest {
  readonly tools: ReadonlyArray<{
    readonly jsServerName: string;
    readonly jsToolName: string;
  }>;
}
```

The request is intentionally batched. Models often need multiple tools for one execution, such as `github.search_issues(...)` followed by `github.create_issue(...)`. Requiring one schema request per tool would make the progressive-discovery flow slower when MCP clients do not parallelize tool calls perfectly.

Return:

```ts
interface GetToolSchemaResult {
  readonly tools: ReadonlyArray<CodeModeToolSchemaResult>;
  readonly declarationsByServer: ReadonlyArray<CodeModeServerDeclaration>;
  readonly diagnostics: ReadonlyArray<CodeModeDiagnostic>;
}

interface CodeModeToolSchemaResult {
  readonly serverName: string;
  readonly jsServerName: string;
  readonly originalToolName: string;
  readonly jsToolName: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
  readonly outputSchemaInvalid?: true;
}

interface CodeModeServerDeclaration {
  readonly serverName: string;
  readonly jsServerName: string;
  /**
   * Self-contained TypeScript declaration bundle for only the requested tools
   * from this server.
   *
   * The namespace must be the real generated-code provider namespace, such as
   * `github`, not a fake per-tool namespace. This bundle is safe to paste into
   * a `.d.ts` file by itself.
   */
  readonly declaration: string;
}
```

Raw JSON schemas stay attached to each selected tool in `tools[]` because they
are the exact machine-readable contract for that tool. TypeScript declarations
are grouped by requested server in `declarationsByServer[]` so a batched request
for two GitHub tools returns one `declare namespace github { ... }` block, not
two same-name namespace blocks. The grouped declaration must include only the
tools requested in this `get_tool_schema` call, not every tool from that server.

This keeps progressive disclosure intact: `search()` does not expose schemas,
`get_tool_schema` does not dump an entire provider, and the declarations still
mirror the real runtime syntax (`github.create_issue(...)`, not a fake
per-tool namespace).

## Key Decisions

- Keep the host-side registry authoritative. `search` may hide schemas from the model-facing response, but `McpRegistry` still discovers and validates upstream MCP tool schemas.
- Do not weaken schema validation. Invalid `inputSchema` remains a hard failure for that upstream server. Invalid `outputSchema` remains a visible warning.
- Do not make generated/sandboxed code responsible for discovering schemas. Generated code remains plain JavaScript and only calls provider functions like `github.create_issue(...)`.
- Use sanitized JS names for `get_tool_schema` lookup because they are the names the model uses in generated code.
- Preserve original MCP names in the response for traceability and diagnostics.
- Fail fast when any requested `jsServerName` or `jsToolName` does not map to exactly one known tool.
- Batched schema lookup is all-or-nothing. If any requested tool is unknown or invalid, the entire `get_tool_schema` request fails with a tool error rather than returning partial success.
- Avoid quiet fallback behavior like "return an empty schema" for missing tools.
- Return raw schemas per selected tool, but return TypeScript declarations grouped by requested server.
- Grouped declarations must include only selected tools from that server, never the entire server inventory.
- Declaration namespaces must use the real `jsServerName`. Do not create fake per-tool namespaces just to avoid duplicate namespace blocks.

## Implementation Notes

### Code Mode Types

Split the current public context shape:

- `CodeModeSearchResult` as the new `CodeMode.search()` return type
- `CodeModeToolSummary`
- `CodeModeToolSchemaRequest`, with a batched `tools` array
- `CodeModeToolSchemaResult`, with raw schema metadata for one requested tool
- `CodeModeServerDeclaration`, with one declaration bundle per requested server

Retire the public `CodeModeContext` name rather than keeping two names for the new lightweight search payload. `search()` currently returns `CodeModeContext`; this ticket should change that signature to return `CodeModeSearchResult`.

Keep full schema metadata in internal runtime state so execution and schema lookup use the same source of truth.

### Code Mode Runtime

Current runtime already builds:

- grouped server/tool metadata
- executor providers
- declaration index
- full context
- diagnostics

Adjust it so startup can still precompile declaration fragments, but `search()` only renders/sends summaries. Add a lookup path for one or more tools:

```txt
CodeMode.toolSchema({ tools: [{ jsServerName, jsToolName }, ...] })
  -> validate every requested server/tool key
  -> find exact tools in cached runtime metadata
  -> group resolved tools by jsServerName while preserving request order
  -> render one namespace-wrapped declaration bundle per requested server
  -> return raw schemas per tool plus declarationsByServer
```

If rendering selected declarations from the existing declaration index is awkward, add a focused server-bundle render helper rather than recompiling JSON Schema on every request.

This focused renderer intentionally differs from the current full-surface `renderDeclarations` output. The existing renderer can emit referenced type blocks outside the namespace and namespace blocks separately. `CodeMode.toolSchema()` must return each `declarationsByServer[].declaration` as one self-contained namespace-wrapped snippet, with the referenced input/output types for the requested tools inside that same snippet.

Do not return one declaration string per tool when multiple requested tools share a server; that creates repeated same-name namespaces and can confuse the model. Do not include unrequested tools from the same server either. For example, if the request asks for `github.search_issues` and `github.create_issue`, return one server declaration:

```ts
declare namespace github {
  interface SearchIssuesInput {
    readonly query: string;
  }

  function search_issues(input: SearchIssuesInput): Promise<unknown>;

  interface CreateIssueInput {
    readonly owner: string;
    readonly repo: string;
    readonly title: string;
  }

  function create_issue(input: CreateIssueInput): Promise<unknown>;
}
```

If the request asks for one GitHub tool and one Slack tool, return two
`declarationsByServer` entries, one for `github` and one for `slack`.

### Server MCP Tools

Expose three public tools:

```txt
search
get_tool_schema
execute
```

Update descriptions so the model sees the intended order:

```txt
1. Use search to find candidate provider APIs.
2. Use get_tool_schema for tools you plan to call.
3. Use execute with generated JavaScript.
```

`execute` remains unchanged except its description should mention that schemas are available through `get_tool_schema`.

### Playground

The playground currently browses generated APIs and schemas through `/api/context` and `/api/tool-declarations`.

Update it to reflect the two-stage flow:

- `/api/context` returns lightweight search/context summaries
- add `POST /api/tool-schema` for selected-tool schema/declaration lookup
- deprecate `/api/tool-declarations`
- `POST /api/tool-schema` accepts a JSON body matching `GetToolSchemaRequest`
- `POST /api/tool-schema` calls the new `CodeMode.toolSchema` service method
- `/api/tool-schema` returns the full batched `GetToolSchemaResult`, so the UI receives raw JSON schemas per tool and cached TypeScript declarations grouped by requested server in one fetch
- schema/declaration panel fetches selected tool schema data on demand
- declaration panel renders the relevant server declaration bundle for the selected tool
- UI should make selected-tool schema loading explicit
- avoid assuming declarations are present on initial context load

## Tests

Code Mode tests:

- `search()` returns tool summaries without `inputSchema`, `outputSchema`, or declaration bundle
- `search({ query })` still filters by server/tool name, title, and description
- `toolSchema()` returns raw schemas for one valid selected tool
- `toolSchema()` returns raw schemas for multiple valid selected tools in one request
- `toolSchema()` returns declaration bundles grouped by requested server
- when two requested tools share a server, the response contains one `declarationsByServer` entry and one `declare namespace <server>` block containing both requested functions and their input/output types
- when requested tools span servers, the response contains one declaration entry per server
- declaration bundles do not include unrequested tools from the same server
- `toolSchema()` fails fast for unknown `jsServerName`
- `toolSchema()` fails fast for unknown `jsToolName`
- batched `toolSchema()` is all-or-nothing when any requested tool is invalid
- invalid output schema tool returns `outputSchemaInvalid: true` and declaration output type `unknown`
- diagnostics are still included in both search and schema responses

Server tests:

- public MCP server exposes `search`, `get_tool_schema`, and `execute`
- `search` text instructs the model to call `get_tool_schema` before generating code for a selected tool
- `get_tool_schema` structured content contains selected tool schemas and server-grouped declarations
- `get_tool_schema` accepts multiple selected tools in one request
- `get_tool_schema` fails the whole batch if any requested tool is unknown
- missing tool lookup returns a tool error, not an empty or misleading schema

Playground tests:

- initial context load does not require declarations
- selecting a tool fetches and displays that tool's schema/declaration from `POST /api/tool-schema`
- no UI path depends on `/api/tool-declarations`
- selected-tool schema errors render visibly

Verification:

```bash
pnpm --filter @ptools/code-mode test
pnpm --filter @ptools/server test
pnpm --filter @ptools/playground test
pnpm typecheck
pnpm build
```

## Non-Goals

- No changes to upstream MCP discovery: still use `listTools`.
- No changes to execution syntax.
- No schema summarization or lossy schema compression in this ticket.
- No dynamic upstream rediscovery per `search()` call.
- No CLI or UI beyond updating the existing playground behavior.
