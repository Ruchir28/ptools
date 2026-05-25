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

Remote HTTP MCP servers can opt into OAuth metadata overrides when discovery is
not enough:

```json
{
  "mcpServers": {
    "notion": {
      "url": "https://example.com/mcp",
      "auth": {
        "type": "oauth",
        "scope": "read write",
        "clientId": "optional-pre-registered-client-id",
        "clientSecret": "${env:OPTIONAL_CLIENT_SECRET}"
      }
    }
  }
}
```

When an upstream HTTP server needs OAuth, ptools stays connected and prints a
local auth center URL:

```txt
[ptools] Auth center: http://127.0.0.1:7342/auth
```

Open that URL to see every configured upstream MCP server, its auth state, and
OAuth actions such as authorize or retry. OAuth tokens are stored in the OS
credential store, not in `.ptools/config.json`.

Some MCP servers use an OAuth provider that does not support Dynamic Client
Registration. In that case ptools marks the server as `needs_config` and shows
setup options in the auth center:

- add a pre-registered OAuth `clientId` and `clientSecret`
- add only `clientId` when the provider supports public PKCE clients
- use an `Authorization: Bearer ${env:TOKEN}` header when that MCP server
  supports static bearer tokens

ptools keeps running in this state, so other upstream MCP servers continue to
work while the user fixes that server's config.

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

For concrete Claude Code and OpenCode setup files, see
`examples/mcp-hosts` in the repository.

## Embed

```ts
import { Effect } from "effect";
import { runServer } from "@ptools/mcp-server";

await Effect.runPromise(
  runServer(process.argv.slice(2), process.env, process.cwd()),
);
```

## Tools

The server exposes six MCP tools:

- `auth_status` shows the auth center URL and upstream server auth states.
- `refresh` reconnects and rediscovers upstream servers after auth changes.
- `search_providers` finds configured MCP provider namespaces.
- `search` finds callable actions for a task query.
- `get_tool_schema` fetches full schemas and TypeScript declarations.
- `execute` runs generated JavaScript against discovered provider APIs.
