# ptools Project Spec

## Summary

`ptools` is an MCP-first Code Mode wrapper. It takes many upstream MCP servers and exposes one combined MCP server with a small model-facing surface:

```txt
search({ query?: string })
get_tool_schema({ tools: [{ jsServerName, jsToolName }] })
execute({ code })
```

Generated code calls provider-style APIs:

```ts
async () => {
  const issue = await github.create_issue({
    owner: "example",
    repo: "repo",
    title: "Example",
  });

  return issue;
};
```

At runtime, `github.create_issue` is not a real SDK client inside the sandbox. It is a host-backed provider proxy that calls back to the Code Mode host, which dispatches through `McpRegistry.callTool(...)` to the original upstream MCP tool.

## Architecture

The system has five named parts. Avoid using the word "host" without qualifying which one.

```txt
User harness / MCP client
  -> Combined Code Mode MCP server (apps/server)
  -> CodeMode (packages/code-mode)
  -> McpRegistry (packages/mcp-registry)
  -> LocalSandboxExecutor + shared Executor RPC host (packages/executor)
  -> sandbox process
  -> callback to Executor RPC host
  -> McpRegistry.callTool(...)
  -> upstream MCP server
```

### Code Mode Host

The Code Mode host is the running service/process that exposes the combined MCP server. In local v1 this is the user's local Node process. In remote future, this can be a deployed service.

Responsibilities:

- load upstream MCP config (`apps/server`)
- construct `McpRegistry`, executor, and `CodeMode` Effect layers
- expose combined MCP tools: `search`, `get_tool_schema`, and `execute`
- create provider handlers backed by `McpRegistry.callTool(...)`
- keep MCP clients, credentials, policy, and env away from sandbox code
- print startup diagnostics to `stderr` when upstreams fail

### MCP Registry

`McpRegistry` is an internal host-side service used by Code Mode. It is not a separate server in v1.

Responsibilities:

- connect configured upstream MCP servers independently (degraded startup)
- support stdio and Streamable HTTP transports
- discover tools via `listTools`
- preserve original MCP server/tool names
- sanitize names into JavaScript identifiers for generated code
- fail fast on name collisions and mapping invariants
- record structured diagnostics for failed connections, discovery failures, and schema issues
- start successfully even when all upstreams fail
- dispatch generated-code calls back to original MCP `callTool`
- close MCP clients through Effect scoped lifetimes

**Schema enforcement policy:**

- Invalid `inputSchema` is a hard failure for that upstream server: the server is excluded, and `InvalidInputSchema` + `McpDiscoveryFailed` diagnostics are recorded.
- Invalid `outputSchema` is a warning: the tool remains exposed, `outputSchemaInvalid: true` is set on the discovered tool, Code Mode uses `Promise<unknown>` for generated declarations, and an `InvalidOutputSchema` diagnostic is recorded.
- Name collisions are always hard failures; degraded startup cannot safely choose one JS name.

**Tolerant AJV validator:**

The official MCP SDK `Client` eagerly compiles every advertised `outputSchema` with AJV during `listTools()`. `TolerantOutputSchemaValidator` is injected at client construction time to prevent a broken optional schema from killing discovery. Good schemas still compile normally. Broken schemas fall through to a per-schema pass-through validator, and the post-discovery validation step records the diagnostic.

### Executor RPC Host

The Executor RPC host is an internal callback server owned by the executor. It is not an MCP registry and does not know how to discover MCP tools.

V1 shape:

```txt
one Code Mode service instance
  -> one LocalSandboxExecutor
    -> one shared localhost Executor RPC host
      -> many active run entries
```

Each execution registers:

- `runId`
- bearer token
- provider map
- completion/failure handlers

Sandbox code calls:

```txt
POST /runs/:runId/call
POST /runs/:runId/complete
```

The RPC host routes the callback to the provider handler registered for that run. That handler is created by Code Mode and usually calls `McpRegistry.callTool(...)`.

### Sandbox Runtime

The sandbox runs generated JavaScript. It receives:

- generated code
- serializable globals
- provider manifest
- callback URL
- run token

The sandbox does not receive:

- upstream MCP clients
- MCP config
- env vars or API keys
- raw host process access

### Upstream MCP Servers

Upstream MCP servers are the real side-effect layer. They live wherever the Code Mode host can reach or spawn them.

Important deployment rule:

```txt
stdio MCP runs wherever the Code Mode host runs.
```

If Code Mode is remote, a stdio MCP config starts on the remote machine/container, not on the user's laptop. User-local stdio MCPs from a remote Code Mode host require a future local bridge/connector.

## Package Responsibilities

### `packages/mcp-registry`

Implemented host-side MCP integration.

Current key API:

```ts
makeMcpRegistryLive(upstreams);
McpRegistry.listTools;
McpRegistry.diagnostics;
McpRegistry.callTool;
```

Key internals:

- `connect.ts`: `connectConfiguredMcpClientsDegraded` — connects each upstream independently, collecting `McpConnectionFailed` diagnostics for failed ones
- `discovery.ts`: `discoverAllToolsDegraded` — discovers tools per client independently, collecting `McpDiscoveryFailed` / `InvalidInputSchema` / `InvalidOutputSchema` diagnostics
- `dispatch.ts`: `dispatchToolCall` — routes JS-facing calls back to original upstream MCP tool names
- `names.ts`: `sanitizeJsIdentifier`, `buildNameMap`, `getMappedName` — name sanitization and collision detection
- `schema.ts`: `TolerantOutputSchemaValidator`, `validateInputSchema`, `validateOutputSchema`

Covered by unit tests and a real stdio MCP integration test.

### `packages/executor`

Implemented configurable local code execution.

Current key API:

```ts
execute({
  code,
  globals,
  providers,
  timeoutMs,
});
```

The local executor:

- starts one shared localhost RPC host per scoped executor instance
- starts one fresh Node sandbox process per execution
- passes only code, globals, provider manifest, callback URL, and token to the sandbox
- captures `console.log`, `console.warn`, `console.error`
- enforces timeout and cleans up process and active run entries
- uses Effect for lifecycle, request routing, provider dispatch, and typed errors
- remains MCP-agnostic

Provider handlers are Effect-returning host capabilities:

```ts
{
  name: "github",
  fns: {
    create_issue: (input) => Effect.succeed(...)
  }
}
```

Generated/sandboxed code stays plain JavaScript and does not know Effect.

### `packages/code-mode`

Implemented orchestration over registry metadata and executor providers.

Current key API:

```ts
makeCodeModeLive(options?)
CodeMode.search(request?)
CodeMode.toolSchema(request)
CodeMode.execute(request)
```

Key internals:

- `CodeMode.ts`: Effect service tag and `makeCodeModeLive` layer
- `context.ts`: groups flat `DiscoveredMcpTool[]` into `CodeModeServerMetadata[]`, builds executor providers, builds the declaration index, caches schema-free `fullSearchResult`
- `declarations.ts`: `buildDeclarationIndex` (startup, async, Effect-based), `renderDeclarations` (synchronous render from cached fragments), `renderServerDeclaration` (self-contained requested-server snippet)
- `types.ts`: all public metadata/request/result types

Decisions:

- At layer startup, Code Mode calls `McpRegistry.listTools` once and calls `McpRegistry.diagnostics` once. Both are cached for the layer lifetime.
- `buildDeclarationIndex` compiles all JSON Schemas once at startup using `json-schema-to-typescript`. `renderDeclarations` is a pure render step that stitches cached fragments; it never re-compiles schemas.
- Blank/missing `search` query returns a precomputed schema-free `fullSearchResult`.
- Non-blank `search` query filters metadata only; it does not render declarations or include raw schemas.
- `toolSchema` does all-or-nothing exact lookup for one or more `{ jsServerName, jsToolName }` pairs and returns raw schemas per requested tool plus self-contained declarations grouped by requested server from cached fragments.
- Registry diagnostics are carried into every `search()` response (both `structuredContent` and the formatted text response).
- Registry diagnostics are also carried into every `toolSchema()` response.
- Tools with `outputSchemaInvalid: true` get `Promise<unknown>` in generated declarations; their `outputSchema` field is not compiled.
- Provider handlers call `McpRegistry.callTool(...)` and unwrap `CallToolResult` before returning to sandbox code (see MCP Result Unwrapping below).

### `apps/server`

Implemented combined MCP server entrypoint.

Responsibilities:

- parse `--config <path>` or `PTOOLS_CONFIG` env var
- load and validate canonical MCP-style `ptools.config.json`
- resolve `${env:NAME}` placeholders into literal command/args/cwd/env/url/headers values before passing to `makeMcpRegistryLive`
- construct Effect layers: `makeMcpRegistryLive`, `makeLocalSandboxExecutorLive`, `makeCodeModeLive`
- register `search`, `get_tool_schema`, and `execute` on an SDK `McpServer`
- connect over stdio via `StdioServerTransport`
- print startup diagnostics to `stderr` if any configured upstream failed
- keep the scope alive until stdio/process shutdown
- startup/config/layer failures write a safe message to `stderr` and exit non-zero
- tool invocation errors return MCP results with `isError: true`

## Server Config Shape

```ts
interface PtoolsConfig {
  readonly mcpServers: Record<string, ServerMcpConfig>;
  readonly executor?: {
    readonly defaultTimeoutMs?: number;
  };
}

type ServerMcpConfig =
  | {
      readonly command: string;
      readonly args?: ReadonlyArray<string>;
      readonly cwd?: string;
      readonly env?: Record<string, string>;
      readonly enabled?: boolean;
      readonly disabled?: boolean;
    }
  | {
      readonly url: string;
      readonly headers?: Record<string, string>;
      readonly enabled?: boolean;
      readonly disabled?: boolean;
    };
```

Resolution rules:

- `command` implies stdio, `url` implies HTTP.
- `transport` and `type` are rejected; use `command` or `url` instead.
- `${env:NAME}` placeholders resolve from the supplied env map / `process.env`; missing refs fail startup.
- `disabled: true` and `enabled: false` exclude the server from the resolved config.
- Relative stdio `cwd` values resolve from the config file directory.
- After resolution, only registry-compatible `transport`, `command`, `args`, `cwd`, `env`, `url`, and `headers` fields are passed to `makeMcpRegistryLive`.
- The config key (e.g. `fixture`) becomes the user-facing provider namespace, regardless of the upstream MCP server's internal name.
- Relative config paths resolve from `process.cwd()`.

Example config:

```jsonc
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${env:GITHUB_TOKEN}",
      },
    },
    "remoteDocs": {
      "url": "https://example.com/mcp",
      "headers": {
        "authorization": "Bearer ${env:REMOTE_DOCS_AUTH}",
      },
    },
  },
  "executor": {
    "defaultTimeoutMs": 30000,
  },
}
```

## Search, Schema, And Execute Semantics

### `search`

`search` is metadata-only. It accepts `{ query?: string }`, never generated code, and must not invoke the executor.

It is how the model discovers the generated-code API surface before choosing which tool schemas to fetch.

- Blank or missing `query`: returns precomputed schema-free `fullSearchResult`.
- Non-blank `query`: filters metadata by query tokens.
- It does not return `inputSchema`, `outputSchema`, or a declaration bundle.

Query matching:

- trim and split on whitespace
- match case-insensitively against original and JS server/tool names, `title`, and `description`
- include a tool if any token matches any field
- preserve original discovery order
- exclude servers where all tools were filtered out

Response shape (`CodeModeSearchResult`):

```ts
interface CodeModeSearchResult {
  readonly servers: ReadonlyArray<CodeModeServerSummary>;
  readonly diagnostics: ReadonlyArray<CodeModeDiagnostic>;
}
```

`diagnostics` is always present; empty means every configured upstream loaded cleanly. The server also renders a human-readable `Diagnostics:` section in the text content response.

`search` must not expose live MCP clients, provider handlers, credentials, or sandbox bindings.

### `get_tool_schema`

`get_tool_schema` fetches full schema and declaration details for selected tools. It accepts a batch because generated-code plans often use several tools together.

Request shape:

```ts
interface GetToolSchemaRequest {
  readonly tools: ReadonlyArray<{
    readonly jsServerName: string;
    readonly jsToolName: string;
  }>;
}
```

Lookup uses sanitized names from `search()`. It is all-or-nothing: if any requested server/tool pair is unknown, the entire request fails with a tool error. It does not rediscover upstream MCP tools.

Response shape:

```ts
interface CodeModeToolSchemaResult {
  readonly tools: ReadonlyArray<CodeModeToolSchema>;
  readonly declarationsByServer: ReadonlyArray<CodeModeServerDeclaration>;
  readonly diagnostics: ReadonlyArray<CodeModeDiagnostic>;
}

interface CodeModeToolSchema {
  readonly serverName: string;
  readonly jsServerName: string;
  readonly originalToolName: string;
  readonly jsToolName: string;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
  readonly outputSchemaInvalid?: true;
}

interface CodeModeServerDeclaration {
  readonly serverName: string;
  readonly jsServerName: string;
  readonly declaration: string;
}
```

Raw schemas stay attached per requested tool in `tools[]`. TypeScript declarations are grouped in `declarationsByServer[]`, with one standalone namespace-wrapped snippet per requested server. Each declaration bundle includes referenced input/output types inside the real provider namespace and only includes tools requested in this `get_tool_schema` call.

### `execute`

`execute` runs generated JavaScript against grouped provider namespaces.

Allowed provider call shape:

```ts
<server>.<tool>(arguments)
```

Code Mode builds provider namespaces from `McpRegistry.listTools()` once at layer startup. Each provider function calls `McpRegistry.callTool(...)` with the original upstream MCP names. Invalid server/tool names and broken name mappings fail loudly.

## MCP Result Unwrapping

Provider handlers unwrap `CallToolResult` before returning to sandbox code. Unwrapping follows Cloudflare-style rules:

| MCP result case                    | Runtime value returned to sandbox                                   |
| ---------------------------------- | ------------------------------------------------------------------- |
| `isError: true`                    | thrown `Error` with text content message                            |
| `structuredContent` present        | `structuredContent` object                                          |
| all `content` items are text       | `JSON.parse` of joined text, or joined text string if parsing fails |
| image/audio/resource/mixed content | raw `CallToolResult` (content preserved, not dropped)               |
| registry/protocol/dispatch failure | thrown provider error                                               |

The typed output promise from a declaration (e.g. `Promise<FixtureAddOutput>`) reflects the expected `structuredContent` shape when `outputSchema` is present and valid. Tools without a valid `outputSchema` use `Promise<unknown>`.

## TypeScript Declaration Generation

Generated declarations are model-facing guidance, not host-side type enforcement.

Example output shape:

```ts
interface FixtureAddInput {
  a: number;
  b: number;
}

interface FixtureAddOutput {
  sum: number;
}

declare namespace fixture {
  /**
   * Add two numbers
   */
  function add(input: FixtureAddInput): Promise<FixtureAddOutput>;
}
```

Rules:

- one `declare namespace <jsServerName>` per MCP server
- one `function <jsToolName>(input: <InputType>): Promise<OutputType>` per tool
- `title` / `description` rendered as JSDoc; original MCP name included in JSDoc when it differs from the JS name
- `json-schema-to-typescript` compiles schemas; type names are `PascalCase(jsServerName) + PascalCase(jsToolName) + Input|Output`
- absent, non-object, or failed input schema → `unknown` for input type (no input declaration emitted)
- absent, non-object, failed, or `outputSchemaInvalid` output schema → `Promise<unknown>` (no output declaration emitted)
- top-level `export` keywords stripped before embedding in `declarations`
- duplicate generated type names fail fast at context construction

Declaration compilation happens once at `makeCodeModeLive` startup via `buildDeclarationIndex`. `renderDeclarations` is a pure synchronous render from cached fragments and never re-invokes `json-schema-to-typescript`.

`renderServerDeclaration` uses the same cached fragments, but intentionally emits a different selected-server format: referenced input/output type declarations for only the requested tools are placed inside one `declare namespace <provider>` block with those tool function signatures.

## Registry Diagnostics

Structured `McpRegistryDiagnostic` type:

```ts
type McpRegistryDiagnostic =
  | {
      code: "McpConnectionFailed";
      severity: "error";
      serverName: string;
      message: string;
    }
  | {
      code: "McpDiscoveryFailed";
      severity: "error";
      serverName: string;
      message: string;
    }
  | {
      code: "InvalidInputSchema";
      severity: "error";
      serverName: string;
      toolName: string;
      message: string;
    }
  | {
      code: "InvalidOutputSchema";
      severity: "warning";
      serverName: string;
      toolName: string;
      message: string;
    };
```

Diagnostics are surfaced in three places:

1. `McpRegistry.diagnostics` — consumed by Code Mode at startup.
2. `CodeModeSearchResult.diagnostics` — included in every `search()` response (`structuredContent` and text).
3. `CodeModeToolSchemaResult.diagnostics` — included in every `toolSchema()` response.
4. `stderr` — printed once after layer construction if any diagnostics exist.

## Local And Remote Deployment Model

### Local V1

```txt
Code Mode host: local Node process
MCP Registry: inside local host
Executor RPC host: local shared localhost server
Sandbox: local Node child process per execution
stdio MCPs: spawned locally
HTTP MCPs: connected by local host
```

Local users do not configure a callback URL. The local executor starts its callback server internally on a random localhost port.

### Remote Future

```txt
Code Mode host: deployed service
MCP Registry: inside remote host
Executor RPC host: remote/public or tunneled callback endpoint
Sandbox: remote sandbox service
stdio MCPs: spawned on remote host/container
HTTP MCPs: connected by remote host
```

Remote sandbox support requires the sandbox to reach the Code Mode host's callback URL and present the run token.

### User-Local MCPs From Remote Host

Not v1. A remote Code Mode host cannot spawn or connect to stdio MCP processes on the user's laptop unless a local bridge/connector is running on that laptop.

Future bridge shape:

```txt
remote Code Mode host
  -> authenticated local bridge
  -> user-local stdio MCP servers
```

## Naming Rules

MCP names can contain characters that are not legal JavaScript identifiers. The host sanitizes names for generated code and preserves reverse mappings.

Examples:

```txt
create-issue         -> create_issue
github.createIssue   -> github_createIssue
delete               -> delete_
3d-render            -> _d_render
```

If two names sanitize to the same identifier, startup/discovery fails loudly. Do not silently rename or suffix critical API names. Name collisions are a hard failure even under degraded startup.

## Error And Type Policy

External MCP boundaries use `unknown` until runtime validation has occurred. This is intentional because MCP schemas are discovered at runtime.

Use Effect tagged errors for host-side failures:

- connection failures (`McpConnectionError`)
- discovery failures (`McpDiscoveryError`)
- name collisions (`NameCollisionError`)
- missing mapped names
- missing tools (`ToolNotFound`)
- invalid tool arguments (`InvalidToolArguments`)
- upstream MCP call failures (`McpCallError`)
- Code Mode invariant failures (`CodeModeInvariantError`)
- executor start/protocol/runtime/timeout failures

Invalid input schemas and invalid output schemas produce `McpRegistryDiagnostic` entries, not thrown Effect errors, to support degraded startup.

Generated TypeScript declarations are model guidance. They do not make upstream MCP data compile-time safe inside the host.

Do not add quiet fallbacks for critical mapping failures. Prefer fail-fast behavior for schema, name mapping, and dispatch invariants.

## Testing

Verification commands:

```bash
pnpm --filter @ptools/mcp-registry test
pnpm --filter @ptools/executor test
pnpm --filter @ptools/code-mode test
pnpm --filter @ptools/server test
pnpm test
pnpm typecheck
pnpm build
```

### `mcp-registry` test coverage

Unit tests:

- JS name sanitization rules
- name collision failure
- missing mapped-name failure
- paginated tool discovery across fake MCP clients
- dispatch from JS-facing names to original MCP tool names
- invalid argument rejection
- `discoverAllToolsDegraded`: one upstream fails connection, another succeeds
- `discoverAllToolsDegraded`: one upstream fails discovery, another succeeds
- `discoverAllToolsDegraded`: all upstreams fail → empty tools, all diagnostics
- `discoverAllToolsDegraded`: invalid `inputSchema` excludes server and records error diagnostics
- `discoverAllToolsDegraded`: invalid `outputSchema` records warning, keeps tool with `outputSchemaInvalid: true`

Integration tests (real stdio MCP fixture):

- registry connects, discovers, and dispatches to a real stdio server
- degraded startup: fixture succeeds, unavailable server records `McpConnectionFailed`
- all-fail: empty tools plus diagnostics
- broken optional output schema: tool callable, `outputSchemaInvalid: true`, `InvalidOutputSchema` warning

### `executor` test coverage

- async function execution with serializable globals
- console log capture
- provider namespace functions
- sequential executions through one scoped executor host
- concurrent executions routed to correct run/provider handlers
- provider result and error propagation over HTTP RPC
- invalid provider/global name failures
- invalid code failure
- uncaught sandbox error propagation
- timeout cleanup
- wrong token and unknown run rejection
- completed run removal from active run map
- scoped RPC host shutdown

### `code-mode` test coverage

Unit tests:

- `search()` returns schema-free API summaries
- `search({ query })` filters servers and tools
- `toolSchema()` returns one and multiple selected tool schemas
- `toolSchema()` declarations are self-contained namespace-wrapped snippets grouped by requested server
- `toolSchema()` does not include unrequested tools from the same server declaration bundle
- `toolSchema()` fails the whole batch when any requested server/tool is unknown
- registry diagnostics carried through `search()` structured context
- diagnostics section rendered in `search()` text response
- declaration generation for object schemas (required and optional fields)
- declaration generation for arrays, enums, consts, and primitives
- output schema compilation to typed `Promise<OutputType>`
- absent output schema falls back to `Promise<unknown>`
- `outputSchemaInvalid: true` tools get `Promise<unknown>`, no output interface emitted
- malformed schema falls back to `unknown` without breaking other tools
- top-level `export` keyword stripping
- duplicate generated type name fails fast
- deterministic declaration ordering
- provider construction dispatching to correct `jsServerName` / `jsToolName`
- `structuredContent` unwrapping returns plain structured value
- text-only content joining and JSON parse attempt
- image/audio/resource or mixed content preserves raw `CallToolResult`
- `isError: true` surfaces as thrown sandbox error
- provider dispatch failures surface as thrown sandbox errors
- selected schema lookup does not re-compile schemas (compile count regression)
- duplicate grouped provider/tool entries fail fast

Integration tests (stdio MCP fixture):

- `search()` includes `fixture.echo` and `fixture.add`
- `search({ query: "echo" })` returns filtered surface only
- `toolSchema()` for `fixture.echo` includes `declare namespace fixture`
- `execute({ code })` calls `fixture.echo` and `fixture.add` end-to-end
- returned value is the unwrapped structured result
- console logs from generated code are preserved
- provider errors can be caught inside generated code

### `apps/server` test coverage

Config tests:

- valid stdio/HTTP config resolves to registry-compatible config
- literal `env` / `headers` preserved
- `${env:NAME}` placeholders resolved from env map
- missing env placeholders fail loudly
- `transport` / `type` and unsupported copied client fields fail clearly
- disabled servers are excluded from resolved config
- invalid config shape fails
- `--config` and `PTOOLS_CONFIG` path resolution

Server integration tests (full stack, real stdio):

- public tools are only `search`, `get_tool_schema`, and `execute`
- `search()` returns healthy tools plus diagnostics for broken server
- `search({ query })` returns filtered surface
- `get_tool_schema` returns selected schema/declaration details
- `execute({ code })` dispatches through fixture MCP end-to-end
- all-upstreams-fail config still starts; `search()` returns empty `servers` plus diagnostics
- fixture with broken optional `outputSchema` is exposed and callable

## Architecture Decisions Log

Decisions made across tickets 1–8, recorded here to prevent drift:

- **MCP-first**: ptools is a registry + dispatch layer, not a generic tool runner or fake-tool framework. Fake tools are test doubles only.
- **Effect-TS for host code**: services, async orchestration, resource lifetimes, and typed errors all use Effect. Generated/sandbox code stays plain JS.
- **Provider handlers are Effect-returning**: host capabilities wrap promise/value work with `Effect.promise` or `Effect.succeed`, not raw promises.
- **Degraded startup**: each upstream is connected and discovered independently. Failures become diagnostics. The registry and server start even when all upstreams fail.
- **Input schema is critical, output schema is optional**: invalid `inputSchema` excludes that server; invalid `outputSchema` warns and marks the tool, but the tool remains exposed.
- **TolerantOutputSchemaValidator injection**: prevents the SDK from killing `listTools` on broken `outputSchema` while preserving normal AJV validation for good schemas.
- **No blanket no-op validator**: tolerance is scoped to broken schemas only, not applied globally.
- **Name collision = hard failure always**: even under degraded startup, name collisions cannot be safely resolved and always fail.
- **Declaration caching at startup**: `buildDeclarationIndex` runs once when the Code Mode layer starts. Search and schema lookup never re-compile schemas.
- **Two-stage discovery**: `search` returns schema-free summaries; `get_tool_schema` returns batched full schemas per selected tool and self-contained declarations grouped by requested server.
- **Precomputed full search result**: blank/absent `search` query returns a startup-cached schema-free `fullSearchResult`; no filtering or rendering occurs.
- **Config key is the provider namespace**: the `mcpServers` config key determines the user-facing JS namespace (e.g. `fixture`), not the upstream server's internal self-reported name.
- **Config-file shape is normal MCP JSON**: `command` implies stdio and `url` implies HTTP; legacy `transport`, `type`, `envFrom`, and `headersFromEnv` are rejected with targeted messages.
- **Config secret resolution is placeholder-based**: `${env:NAME}` placeholders resolve before the registry is constructed. The `mcp-registry` types only accept resolved literal env/headers.
- **Config validation is fail-fast**: copied client fields that imply unsupported behavior are rejected instead of ignored. `zod` is used only for MCP SDK tool schema registration.
- **No per-server strict/permissive config option**: output schema tolerance is uniform across all upstreams.
- **No automatic schema repair**: broken schemas are flagged and preserved as-is; ptools does not mutate upstream schema metadata.
- **Diagnostics in model-facing responses**: `McpRegistry.diagnostics` is included in `CodeModeSearchResult`, `CodeModeToolSchemaResult`, and startup `stderr` output.

## Non-Goals For V1

- No CLI product.
- No web UI.
- No production sandbox guarantee from the first Node executor.
- No direct exposure of upstream MCP tools as individual wrapper tools.
- No remote executor implementation yet.
- No user-local MCP bridge from a remote Code Mode host yet.
- No generic fake-tool framework as the core abstraction.
- No per-server strict/permissive schema validation config.
- No automatic repair or mutation of upstream schema metadata.
- No dynamic MCP config reload.
- No public HTTP combined MCP server transport.
- No remote auth/OAuth changes.

Fake or in-memory tools are allowed only as test doubles. The product abstraction is MCP server composition.
