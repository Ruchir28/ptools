# Ticket 3: Code Mode Orchestrator

## Summary

Implement `@ptools/code-mode` as the host-side orchestration layer over the already-built MCP registry and executor.

The package should expose a small Effect service:

```txt
search({ query?: string })
  -> model discovers available MCP-backed APIs
  -> returns matching grouped metadata and generated TypeScript declarations

execute({ code })
  -> runs generated JavaScript through CodeExecutor
  -> generated code calls provider namespaces like fixture.add(...)
  -> provider handlers dispatch through McpRegistry.callTool(...)
```

This keeps the project MCP-first. Code Mode does not own upstream MCP clients, does not discover tools itself, and does not expose raw MCP clients or credentials to sandbox code.

## Research Notes

Cloudflare Code Mode uses the same broad shape:

- `createCodeTool` generates TypeScript type definitions from tool descriptors and gives the model a single code-writing tool.
- Sandbox code calls generated tool APIs, while calls are proxied back to the host dispatcher.
- Their MCP wrapper turns upstream MCP tools into typed sandbox methods and dispatches back to MCP `callTool`.
- Their MCP wrapper unwraps MCP `CallToolResult` values before returning them to sandbox code, so generated code usually sees the useful structured/plain value instead of the MCP wrapper.
- Their newer exports include `generateTypesFromJsonSchema` and `jsonSchemaToType`, which confirms that generating model-facing declarations from JSON Schema is a first-class part of the design.
- MCP `CallToolResult.content` can contain multiple modalities: text, image, audio, resource links, and embedded resources. Unwrapping must not discard those rich results.

Relevant references:

- https://developers.cloudflare.com/agents/api-reference/codemode/
- https://developers.cloudflare.com/changelog/post/2026-03-17-codemode-sdk-v021/
- https://github.com/cloudflare/agents/issues/1126

For v1, use `json-schema-to-typescript` for model-facing declarations instead of hand-rolling JSON Schema conversion. MCP servers can expose real JSON Schema, and good generated types directly improve the model's ability to chain tool calls.

## Public API

Add a `CodeMode` service:

```ts
export class CodeMode extends Context.Tag("@ptools/CodeMode")<
  CodeMode,
  {
    readonly search: (
      request?: CodeModeSearchRequest,
    ) => Effect.Effect<CodeModeContext, CodeModeError>;
    readonly execute: (
      request: CodeModeExecuteRequest,
    ) => Effect.Effect<CodeModeRunResult, CodeModeError>;
  }
>() {}
```

Core request/result types:

```ts
export interface CodeModeSearchRequest {
  readonly query?: string;
}

export interface CodeModeExecuteRequest {
  readonly code: string;
  readonly timeoutMs?: number;
}

export interface CodeModeRunResult {
  readonly value: unknown;
  readonly logs: ReadonlyArray<CapturedLog>;
}

export interface CodeModeContext {
  readonly servers: ReadonlyArray<CodeModeServerMetadata>;
  readonly declarations: string;
}
```

Layer constructor:

```ts
export const makeCodeModeLive: () => Layer.Layer<
  CodeMode,
  CodeModeError,
  McpRegistry | CodeExecutor
>;
```

`packages/code-mode` should add:

- dependency on `@ptools/mcp-registry`
- dependency on `json-schema-to-typescript`
- tsconfig reference to `../mcp-registry`
- `test` script using Vitest

## Code Mode Context

At layer startup, Code Mode should call `McpRegistry.listTools` once and build an in-memory API surface.

Do not store generated declarations on disk. They are derived from live MCP discovery and belong in memory.

Suggested metadata shape:

```ts
export interface CodeModeServerMetadata {
  readonly serverName: string;
  readonly jsServerName: string;
  readonly tools: ReadonlyArray<CodeModeToolMetadata>;
}

export interface CodeModeToolMetadata {
  readonly originalToolName: string;
  readonly jsToolName: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: unknown;
}
```

`search` returns:

```ts
{
  servers,
  declarations
}
```

Search is how the model discovers tools before writing code:

```txt
1. model calls search({ query: "github issues slack message" })
2. Code Mode filters the already-discovered API surface
3. Code Mode returns matching tool metadata and TS declarations
4. model writes execute({ code }) using those provider APIs
```

For v1, filtering should be simple string matching over:

- original and JS server names
- original and JS tool names
- title
- description

If `query` is absent or blank, return the full API surface.

For non-blank `query`, return only matching servers/tools and regenerate `declarations` from that filtered surface. Do not return full declarations for a filtered search result.

Query matching rules:

- trim the query
- split on whitespace
- match case-insensitively
- include a tool if any token appears in the combined searchable fields
- preserve original discovery order
- include only servers that still have at least one matching tool

No executor is involved in `search`.

## TypeScript Declaration Generation

Generate declarations from the same grouped API surface that powers providers.

Example output:

```ts
interface FixtureAddInput {
  a: number;
  b: number;
}

interface FixtureAddOutput {
  sum: number;
}

interface FixtureEchoInput {
  text: string;
}

interface FixtureEchoOutput {
  text: string;
}

declare namespace fixture {
  /**
   * Add two numbers
   */
  function add(input: FixtureAddInput): Promise<FixtureAddOutput>;

  /**
   * Echo text back to the caller
   */
  function echo(input: FixtureEchoInput): Promise<FixtureEchoOutput>;
}
```

Rules:

- one `declare namespace <jsServerName>` per discovered MCP server
- one `function <jsToolName>(input: <input type>): Promise<output type>` per tool
- include `title` / `description` as JSDoc where present
- include original MCP names in JSDoc when they differ from JS names
- use `json-schema-to-typescript` to compile input and output schemas into named types
- generate stable type names from JS server/tool names, for example `FixtureAddInput` and `FixtureAddOutput`
- remove library banner comments from generated declaration output
- `outputSchema` is optional in MCP and in `DiscoveredMcpTool`
- if `outputSchema` exists and converts cleanly, use the generated output type as the promise result
- if `outputSchema` is absent or unsupported, use `Promise<unknown>`
- never let one bad schema break the whole Code Mode context; isolate schema compilation failures to that tool and emit `unknown` for the failing input/output type

Typing consequences:

- MCP `outputSchema` describes JSON-like `structuredContent`, not arbitrary content blocks.
- Tools with valid `outputSchema` get typed direct output, for example `Promise<FixtureAddOutput>`.
- Tools without valid `outputSchema` get `Promise<unknown>`, because runtime may return parsed JSON, plain text, or a raw rich MCP `CallToolResult`.
- Do not introduce a `CodeModeToolResult` wrapper type in generated declarations. The sandbox API should look like direct function calls.

These declarations are model guidance, not host-side validation. Runtime validation still belongs to the upstream MCP server.

### Declaration Adapter

`json-schema-to-typescript` compiles a schema into standalone declarations, not directly into function signatures. Code Mode should adapt that output instead of trying to make the library emit the final namespace shape.

For each tool:

```ts
compile(tool.inputSchema, "FixtureAddInput", compileOptions);
compile(tool.outputSchema, "FixtureAddOutput", compileOptions);
```

Use these compile options by default:

```ts
{
  bannerComment: "",
  unknownAny: true,
  additionalProperties: true,
  style: {
    semi: true,
    singleQuote: false
  }
}
```

Adapter rules:

- pass MCP `inputSchema` / `outputSchema` to the library as JSON Schema objects
- if a schema value is missing, `null`, non-object, or rejected by the library, use `unknown` for that side
- do not coerce strings, arrays, or other non-object values into invented schemas
- generate deterministic type names from `jsServerName` and `jsToolName`
- type names are `PascalCase(jsServerName) + PascalCase(jsToolName) + Input|Output`
- if two tools produce the same generated type name, fail fast during context construction
- strip only top-level `export` keywords from generated declarations before embedding them in `CodeModeContext.declarations`
- preserve generated `interface`, `type`, helper declarations, JSDoc, and semicolons
- collect compiled declarations before namespace declarations
- emit namespace function signatures that reference the generated type names
- if input schema compilation fails, omit that generated input declaration and use `unknown` for the function input
- if output schema is missing or compilation fails, omit that generated output declaration and use `unknown` for the function result
- because `compile(...)` is async, declaration/context building should run inside Effect using `Effect.promise` or `Effect.tryPromise`
- schema compilation failures are isolated per tool, but provider/name mapping invariants still fail fast

## Provider Generation

Build executor providers once at Code Mode layer startup from the discovered tool metadata.

Build providers during `makeCodeModeLive` from the same discovered surface used for declarations. Reuse the immutable provider array for every `execute` call.

Provider shape passed to the executor:

```ts
[
  {
    name: "fixture",
    fns: {
      add: (input) =>
        registry.callTool({
          jsServerName: "fixture",
          jsToolName: "add",
          arguments: input,
        }),
    },
  },
]
```

Generated code sees only provider namespaces:

```ts
async () => {
  const result = await fixture.add({ a: 2, b: 3 });
  return result.sum;
}
```

Provider handlers should call `McpRegistry.callTool(...)`, then unwrap the returned MCP `CallToolResult` before giving the value back to sandbox code.

MCP result shape to handle:

```ts
type CallToolResult = {
  content: Array<
    | TextContent
    | ImageContent
    | AudioContent
    | ResourceLink
    | EmbeddedResource
  >;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
```

Use Cloudflare-style unwrapping:

- if compat `toolResult` exists, return it directly
- if `isError: true`, throw using text content when available
- if `structuredContent` exists, return it
- if all content items are text, join them with newlines and try `JSON.parse`; if parsing fails, return the text
- otherwise return the raw MCP result for mixed/non-text content

Unwrapping matrix:

| MCP result case | Runtime value returned to sandbox | Declaration type |
| --- | --- | --- |
| `isError: true` | thrown `Error` | normal promise rejection path |
| `structuredContent` present | `structuredContent` object | generated output type when `outputSchema` compiles, otherwise `unknown` |
| all `content` items are text | parsed JSON if possible, otherwise joined text string | `unknown` unless `outputSchema` exists |
| image/audio/resource/mixed content | raw `CallToolResult` | `unknown` unless a separate `structuredContent` path exists |
| registry/protocol/dispatch failure | thrown provider error | normal promise rejection path |

The rich-content branch is important for MCP modalities. If the tool result contains image, audio, resource link, embedded resource, or mixed content blocks and has no `structuredContent`, do not flatten or drop them. Return the raw `CallToolResult` so generated code can inspect `content` directly.

Examples:

```ts
// Valid outputSchema + structuredContent:
const sum = await fixture.add({ a: 2, b: 3 });
// sum is typed as FixtureAddOutput and is usually { sum: 5 }

// No outputSchema + image content:
const imageResult = await image.generate({ prompt: "diagram" });
// imageResult is typed as unknown; at runtime it may be:
// { content: [{ type: "image", data: "...", mimeType: "image/png" }] }
```

If `McpRegistry.callTool(...)` fails at the registry/protocol/dispatch level, the provider Effect fails. The sandbox sees a thrown provider error that generated code may catch.

Provider generation should fail fast if Code Mode detects an impossible invariant, such as duplicate `jsServerName` + `jsToolName` entries in the grouped API surface.

## Implementation Notes

Suggested source split:

- `src/CodeMode.ts`
  - Effect service tag
  - `makeCodeModeLive`
- `src/types.ts`
  - Code Mode public metadata/request/result types
- `src/context.ts`
  - group discovered MCP tools into Code Mode context
  - build provider definitions
- `src/declarations.ts`
  - TypeScript declaration generation
  - `json-schema-to-typescript` integration
  - per-tool fallback to `unknown` on schema compilation failure
- `src/errors.ts`
  - tagged Code Mode errors

Keep the helpers small and boring. Do not introduce a generic tool framework. The inputs are `DiscoveredMcpTool[]`, and the runtime dispatch target is `McpRegistry.callTool`.

`makeCodeModeLive` should be implemented as an Effect layer requiring `McpRegistry | CodeExecutor`. Startup fails on registry/listTools failures and Code Mode invariants such as duplicate provider/tool names or duplicate generated type names. Per-tool declaration schema failures are non-fatal and produce `unknown`.

## Tests

Add unit tests for:

- grouping flat registry tools into server metadata
- `search()` returning the full API surface
- `search({ query })` filtering by tool/server names and descriptions
- `search({ query })` filtering both `servers` and `declarations`
- preserving original MCP names and sanitized JS names
- declaration generation through `json-schema-to-typescript` for object schemas with required and optional fields
- declaration generation through `json-schema-to-typescript` for arrays, enums, consts, and primitive schemas
- declaration generation using `outputSchema` when present
- declaration generation falling back to `Promise<unknown>` when `outputSchema` is absent
- no generated `CodeModeToolResult` wrapper type
- malformed schemas falling back to `unknown` without breaking other tools
- non-object or `null` schemas falling back to `unknown`
- top-level `export interface` / `export type` stripping
- duplicate generated type names failing loudly
- deterministic declaration ordering
- provider construction dispatching to the expected `jsServerName` / `jsToolName`
- MCP `structuredContent` unwrapping to the plain structured value
- text-only MCP content joining/parsing behavior
- image/audio/resource or mixed MCP content preserving the raw `CallToolResult`
- typed output-schema tools returning direct structured values in generated code
- no-output-schema tools remaining typed as `unknown`, including rich content results
- MCP `isError: true` surfacing as a thrown sandbox error
- provider dispatch failures surfacing as thrown sandbox errors
- duplicate grouped provider/tool entries failing loudly

Add an integration test using the existing stdio MCP fixture:

```txt
makeMcpRegistryLive(fixture stdio server)
  + makeLocalSandboxExecutorLive()
  + makeCodeModeLive()
```

Assertions:

- `search()` returns `fixture.echo` and `fixture.add`
- `search({ query: "echo" })` returns `fixture.echo` without requiring generated code
- `search.declarations` includes `declare namespace fixture`
- `execute({ code })` can call `fixture.echo({ text })`
- `execute({ code })` can call `fixture.add({ a: 2, b: 3 })`
- returned value is the unwrapped structured result, for example `{ sum: 5 }`
- console logs from generated code are preserved
- provider errors can be caught inside generated code
- uncaught provider errors return a Code Mode execute failure

Verification:

```bash
pnpm --filter @ptools/code-mode test
pnpm --filter @ptools/code-mode typecheck
pnpm test
pnpm typecheck
pnpm build
```

## Assumptions

- `search` is metadata-only and has no code input.
- `search.query` is optional; blank or missing query returns the full API surface.
- `execute` is the only Code Mode API that runs generated JavaScript.
- Code Mode builds context and providers once at layer startup because `McpRegistryLive` currently discovers tools once at startup.
- Runtime input validation is not part of this ticket. MCP servers remain the source of truth.
- TypeScript declaration generation uses `json-schema-to-typescript`, but compiled declarations are still only model-facing guidance.
- `apps/server` is the next ticket and will expose Code Mode as actual MCP `search` / `execute` tools.
- No declarations are written to disk in v1.
