# ptools Project Spec

## Summary

`ptools` is an MCP-first Code Mode wrapper. It takes many upstream MCP servers and exposes one combined MCP server with a small model-facing surface:

```txt
search({ code })
execute({ code })
```

Generated code should call provider-style APIs:

```ts
async () => {
  const issue = await github.create_issue({
    owner: "example",
    repo: "repo",
    title: "Example"
  });

  return issue;
}
```

At runtime, `github.create_issue` is not a real SDK client inside the sandbox. It is a host-backed provider proxy that calls back to the Code Mode host, which dispatches through `McpRegistry.callTool(...)` to the original upstream MCP tool.

## Architecture

The system has five named parts. Avoid using the word "host" without qualifying which one.

```txt
User harness / MCP client
  -> Combined Code Mode MCP server
  -> McpRegistry
  -> LocalSandboxExecutor + shared Executor RPC host
  -> sandbox process
  -> callback to Executor RPC host
  -> McpRegistry.callTool(...)
  -> upstream MCP server
```

### Code Mode Host

The Code Mode host is the running service/process that exposes the combined MCP server. In local v1, this is the user's local Node process. In remote future, this can be a deployed service.

Responsibilities:

- load upstream MCP config
- construct `McpRegistry`
- construct the executor layer
- expose combined MCP tools, initially `search` and `execute`
- create provider handlers backed by `McpRegistry.callTool(...)`
- keep MCP clients, credentials, policy, and env away from sandbox code

### MCP Registry

`McpRegistry` is an internal host-side service used by Code Mode. It is not a separate server in v1.

Responsibilities:

- connect configured upstream MCP servers
- support stdio and Streamable HTTP transports
- discover tools via `listTools`
- preserve original MCP server/tool names
- sanitize names into JavaScript identifiers for generated code
- fail fast on name collisions and mapping invariants
- dispatch generated-code calls back to original MCP `callTool`
- close MCP clients through Effect scoped lifetimes

### Executor RPC Host

The Executor RPC host is an internal callback server owned by the executor. It is not an MCP registry and does not know how to discover MCP tools.

Current v1 shape:

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
makeMcpRegistryLive(upstreams)
McpRegistry.listTools
McpRegistry.callTool
```

This package is covered by unit tests plus a real stdio MCP integration test.

### `packages/executor`

Implemented configurable local code execution.

Current key API:

```ts
execute({
  code,
  globals,
  providers,
  timeoutMs
})
```

The local executor:

- starts one shared localhost RPC host per scoped executor instance
- starts one fresh Node sandbox process per execution
- passes only code, globals, provider manifest, callback URL, and token to the sandbox
- captures console logs
- enforces timeout
- cleans up process and active run entries
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

Reserved for orchestration over registry metadata and executor providers.

Responsibilities:

- implement `search` over safe tool metadata
- implement `execute` by converting discovered MCP tools into provider namespaces
- generate model-facing TypeScript declarations from discovered MCP tools
- map sanitized JS names back to original MCP server/tool names
- never expose raw MCP clients or secrets to the executor

### `apps/server`

Reserved for the combined MCP server entrypoint.

Responsibilities:

- load project config
- construct Effect layers
- create the combined MCP server
- register `search` and `execute`
- connect the combined server to stdio first

## Search And Execute Semantics

### `search`

`search` runs generated JavaScript against metadata only.

Allowed binding:

```ts
api.servers[]
```

Metadata should include server names, tool names, descriptions, input schemas, output schemas when available, and annotations.

`search` must not expose live MCP clients.

### `execute`

`execute` runs generated JavaScript against grouped provider namespaces.

Allowed provider call shape:

```ts
<server>.<tool>(arguments)
```

Code Mode builds those provider namespaces from `McpRegistry.listTools()`. Each provider function calls `McpRegistry.callTool(...)` with the original upstream MCP server/tool name.

Invalid server/tool names and broken name mappings should fail loudly.

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

Local users should not configure a callback URL. The local executor starts its callback server internally on a random localhost port.

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

This is not v1. A remote Code Mode host cannot spawn or connect to stdio MCP processes on the user's laptop unless a local bridge/connector is running on that laptop.

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
create-issue -> create_issue
github.createIssue -> github_createIssue
delete -> delete_
3d-render -> _d_render
```

If two names sanitize to the same identifier, startup/discovery should fail. Do not silently rename or suffix critical API names.

## Error And Type Policy

External MCP boundaries should use `unknown` until runtime validation has occurred. This is intentional because MCP schemas are discovered at runtime.

Use Effect tagged errors for host-side failures:

- connection failures
- discovery failures
- name collisions
- missing mapped names
- missing tools
- invalid tool arguments
- upstream MCP call failures
- executor start/protocol/runtime/timeout failures

Generated TypeScript declarations are for the model. They do not make upstream MCP data compile-time safe inside the host.

## Testing

Current verification commands:

```bash
pnpm --filter @ptools/mcp-registry test
pnpm --filter @ptools/executor test
pnpm test
pnpm typecheck
pnpm build
```

Current registry test coverage:

- JS name sanitization
- name collision failure
- missing mapped-name failure
- paginated tool discovery across clients
- dispatch to original MCP tool names
- invalid argument rejection
- real stdio MCP fixture server integration

Current executor test coverage:

- async function execution with plain globals
- console log capture
- provider namespace functions
- sequential executions through one scoped executor host
- concurrent executions routed to correct run providers
- provider result and error propagation over HTTP RPC
- invalid provider/global name failures
- invalid code failure
- timeout cleanup
- wrong token and unknown run rejection
- completed run removal from active run map
- scoped RPC host shutdown

Next packages should follow the same pattern:

- unit tests for helpers and failure behavior
- integration tests for the real host-mediated path

## Near-Term Implementation Plan

1. Keep `mcp-registry` stable unless Code Mode reveals an ergonomic issue.
2. Keep `packages/executor` stable unless Code Mode reveals an ergonomic issue.
3. Implement `packages/code-mode` search over registry metadata.
4. Implement `packages/code-mode` execute with provider namespaces backed by `McpRegistry.callTool`.
5. Implement `apps/server` as the stdio combined MCP server exposing `search` and `execute`.

## Non-Goals For V1

- No CLI product.
- No web UI.
- No production sandbox guarantee from the first Node executor.
- No direct exposure of upstream MCP tools as individual wrapper tools.
- No remote executor implementation yet.
- No user-local MCP bridge from a remote Code Mode host yet.
- No generic fake-tool framework as the core abstraction.

Fake or in-memory tools are allowed only as test doubles. The product abstraction is MCP server composition.
