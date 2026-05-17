# Ticket 6: Degraded MCP Registry Startup With Schema Diagnostics

## Summary

Change ptools startup from all-or-nothing upstream MCP loading to degraded startup.

Current issue:

```txt
one configured upstream fails to connect/discover
  -> McpRegistry layer fails
  -> Code Mode server never starts
```

Desired behavior:

```txt
some upstreams fail
  -> ptools still starts
  -> healthy upstreams are available
  -> failed upstreams and broken optional output schemas are reported as diagnostics
```

Even if every upstream fails, ptools should still start and expose `search` / `execute`; `search()` should return an empty API surface plus diagnostics explaining what failed.

## Problem Context

Stitch currently exposes a functional tool whose `outputSchema` has an unresolved `$ref`:

```txt
#/$defs/ScreenInstance
```

The MCP SDK client eagerly compiles every advertised `outputSchema` with AJV during `listTools()`. That means one broken optional output schema can block discovery for the entire server, even though the tool call itself works.

ptools should be strict about critical call contracts, especially `inputSchema`, but tolerant and visible about optional output typing failures.

## Decisions

- Name collisions remain hard failures because degraded startup cannot safely choose one JS namespace/tool name.
- Invalid `inputSchema` is a hard failure for that upstream server, not for all ptools.
- Invalid `outputSchema` is a warning because MCP output schemas are optional.
- One failed upstream MCP should not stop ptools if any other upstreams are healthy.
- If all upstreams fail, ptools should still start with zero tools and diagnostics.
- Do not use a blanket no-op JSON Schema validator.
- Do not add a per-server strict/permissive config option yet.

## Diagnostics

Add structured registry diagnostics:

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

Expose diagnostics from `McpRegistry`:

```ts
readonly diagnostics: Effect.Effect<ReadonlyArray<McpRegistryDiagnostic>>;
```

Code Mode should include diagnostics in `search()`:

```ts
interface CodeModeContext {
  readonly servers: ReadonlyArray<CodeModeServerMetadata>;
  readonly declarations: string;
  readonly diagnostics: ReadonlyArray<CodeModeDiagnostic>;
}
```

The public server should surface diagnostics in two places:

- `search()` structured content and text content
- `stderr` after startup/layer construction completes

## Key Changes

### Registry Startup

- Connect each configured upstream independently.
- On connection failure:
  - record `McpConnectionFailed`
  - continue with remaining upstreams
- On discovery failure:
  - record `McpDiscoveryFailed`
  - close that client
  - continue with remaining upstreams
- If all upstreams fail:
  - return an empty tool list
  - preserve all diagnostics
  - still construct the registry layer

### Schema Validation

- Add explicit schema validation after tool discovery.
- Validate every `inputSchema`.
  - invalid input schema excludes that upstream server
  - record `InvalidInputSchema` / `McpDiscoveryFailed`
- Validate every present `outputSchema`.
  - invalid output schema records `InvalidOutputSchema`
  - tool remains exposed
  - Code Mode treats that output type as `unknown`
- Preserve original upstream schema metadata beside warning metadata where practical.

### SDK Output Validator

- Use a tolerant AJV-backed SDK validator only to prevent SDK eager `outputSchema` compilation from killing `listTools()`.
- Good output schemas still compile and validate normally.
- Broken output schemas return a pass-through validator only for that broken schema and produce diagnostics.
- This is not a blanket no-op validator.

### Code Mode

- Carry registry diagnostics into Code Mode runtime.
- Include diagnostics in full and filtered `search()` responses.
- Render a compact diagnostics section in the text returned by `search()`.
- For invalid output schemas, generated declarations must use `Promise<unknown>`.

### Server

- Print startup diagnostics to `stderr`.
- Keep serving `search` / `execute` even when the registry has zero tools.
- Do not fail server startup only because configured upstreams are unavailable.

## Tests

Registry tests:

- one upstream connection fails, another succeeds -> registry starts with successful tools and connection diagnostic
- one upstream discovery fails, another succeeds -> registry starts with successful tools and discovery diagnostic
- all upstreams fail -> registry starts with zero tools and diagnostics
- invalid input schema excludes that upstream and records error diagnostic
- invalid output schema records warning and keeps the tool exposed
- valid output schema remains available for normal declaration generation

Code Mode tests:

- `search()` includes diagnostics in structured content
- `search()` text includes diagnostics section
- invalid output schema tool gets `Promise<unknown>`
- valid output schema tool keeps generated output interface

Server integration tests:

- fixture config with one healthy MCP and one broken MCP still exposes `search` / `execute`
- `search()` shows healthy tools plus diagnostics for the broken server
- fixture tool with broken optional `outputSchema` is exposed and callable
- all-upstreams-fail config still starts and `search()` returns empty `servers` plus diagnostics

Verification:

```bash
pnpm --filter @ptools/mcp-registry test
pnpm --filter @ptools/code-mode test
pnpm --filter @ptools/server test
pnpm test
pnpm typecheck
pnpm build
```

## Non-Goals

- No per-server strict/permissive config option.
- No automatic repair/mutation of upstream schemas.
- No hiding schema problems silently.
- No validation of every arbitrary runtime value inside sandbox code.
- No remote auth/OAuth changes in this ticket.
