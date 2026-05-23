# @ptools/mcp-server

Combined Code Mode MCP server. It connects to configured upstream MCP servers,
discovers their tools, and exposes a compact set of Code Mode tools to an MCP
host such as Claude Desktop, Codex, Cursor, or any client that speaks MCP over
stdio.

## Install

```bash
npm install @ptools/mcp-server
```

## Configure

Create `.ptools/config.json` in the directory where the server starts:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

Config path resolution follows this order:

1. `--config <path>`
2. `PTOOLS_CONFIG`
3. `.ptools/config.json`
4. `ptools.config.json`

Relative config paths resolve from the server launch directory. Relative
`cwd` values inside the config resolve from the config file's directory. For
`.ptools/config.json`, use `"cwd": ".."` when an upstream server should start
from the project root.

Environment variables can be referenced explicitly:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${env:GITHUB_PERSONAL_ACCESS_TOKEN}"
      }
    }
  }
}
```

## Run

As an installed binary:

```bash
ptools-mcp
```

With `npx`:

```bash
npx @ptools/mcp-server
```

Use an explicit path when the config lives elsewhere:

```bash
ptools-mcp --config ./config/ptools.json
PTOOLS_CONFIG=./config/ptools.json ptools-mcp
```

## Embed

```ts
import { Effect } from "effect";
import { runServer } from "@ptools/mcp-server";

await Effect.runPromise(
  runServer(process.argv.slice(2), process.env, process.cwd()),
);
```

## Tools

The server exposes four MCP tools:

- `search_providers` finds configured MCP provider namespaces.
- `search` finds callable actions for a task query.
- `get_tool_schema` fetches full schemas and TypeScript declarations.
- `execute` runs generated JavaScript against discovered provider APIs.
