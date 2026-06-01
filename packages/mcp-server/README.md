# @ptools/mcp-server

Host-neutral Code Mode MCP adapter. It exposes a compact set of Code Mode tools
to an MCP host over stdio, using a Code Mode client supplied by a host package.
For the local Node binary, use `@ptools/cli`.

## Install

```bash
npm install @ptools/cli
```

Most MCP hosts do not need a project install. They can start the published
package with `npx`:

```bash
npx -y @ptools/cli mcp serve --host node --config .ptools/config.json
```

## Configure

Create `.ptools/config.json` in the directory where the server starts:

```json
{
  "mcpServers": {
    "exa": {
      "url": "https://mcp.exa.ai/mcp"
    },
    "notion": {
      "url": "https://mcp.notion.com/mcp"
    },
    "sheets": {
      "url": "https://mcp.gumloop.com/gsheets/mcp"
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

From the npm registry with `npx`:

```bash
npx -y @ptools/cli mcp serve --host node --config .ptools/config.json
```

From a project where the package is installed:

```bash
ptools mcp serve --host node --config .ptools/config.json
```

Use an explicit path when the config lives elsewhere:

```bash
ptools mcp serve --host node --config ./config/ptools.json
PTOOLS_CONFIG=./config/ptools.json ptools mcp serve --host node
```

For concrete Claude Code and OpenCode setup files, see
`examples/mcp-hosts` in the repository.

## MCP Host Config

Claude Code project config:

```json
{
  "mcpServers": {
    "ptools": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@ptools/cli",
        "mcp",
        "serve",
        "--host",
        "node",
        "--config",
        ".ptools/config.json"
      ]
    }
  }
}
```

OpenCode config:

```json
{
  "mcp": {
    "ptools": {
      "type": "local",
      "command": [
        "npx",
        "-y",
        "@ptools/cli",
        "mcp",
        "serve",
        "--host",
        "node",
        "--config",
        ".ptools/config.json"
      ],
      "enabled": true,
      "timeout": 30000
    }
  }
}
```

In both cases, the MCP host starts one `ptools` server. ptools then connects to
the upstream MCP servers listed in `.ptools/config.json`.

## Embed

```ts
import { Effect } from "effect";
import { createNodeCodeModeClientFromConfigFile } from "@ptools/host-node";
import { serveMcpWithCodeModeClient } from "@ptools/mcp-server";

const client = await createNodeCodeModeClientFromConfigFile(undefined, {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: process.env,
});

await Effect.runPromise(serveMcpWithCodeModeClient(client));
```

## Tools

The server exposes six MCP tools:

- `auth_status` shows the auth center URL and upstream server auth states.
- `refresh` reconnects and rediscovers upstream servers after auth changes.
- `search_providers` finds upstream MCP provider namespaces behind ptools.
- `search` finds callable actions for a task query, optionally narrowed by
  provider.
- `get_tool_schema` fetches full schemas and TypeScript declarations for
  selected action `toolId`s.
- `execute` runs generated JavaScript against discovered provider APIs, which is
  useful for multi-step calls and reducing intermediate results before returning
  a compact answer.
