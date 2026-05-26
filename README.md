# ptools

ptools turns many upstream MCP servers into one Code Mode tool surface. The
model sees a small set of tools for discovery and execution, while host-side
ptools keeps the original MCP registry, tool schemas, and dispatch path
authoritative.

There are two installable alpha paths:

- `@ptools/mcp-server` for MCP hosts such as Claude Code and OpenCode
- `@ptools/agent-tools` for app code using the AI SDK

## MCP Server

Use the MCP server when you want a host to load one `ptools` server that proxies
multiple upstream MCP providers.

```bash
npx -y @ptools/mcp-server --config .ptools/config.json
```

Example `.ptools/config.json`:

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

Claude Code project config:

```json
{
  "mcpServers": {
    "ptools": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@ptools/mcp-server",
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
        "@ptools/mcp-server",
        "--config",
        ".ptools/config.json"
      ],
      "enabled": true,
      "timeout": 30000
    }
  }
}
```

The host sees ptools' stable Code Mode tools: `search_providers`, `search`,
`get_tool_schema`, and `execute`, plus auth helpers. Upstream provider tools are
discovered through `search` and called from generated JavaScript passed to
`execute`.

## AI SDK

Use the AI SDK package when you want to embed ptools in your own app:

```bash
npm install @ptools/agent-tools
```

```ts
import { generateText, stepCountIs } from "ai";
import { openai } from "@ai-sdk/openai";
import { createPtoolsSessionFromConfigFile } from "@ptools/agent-tools";
import { toAISDKTools } from "@ptools/agent-tools/ai-sdk";

const ptools = await createPtoolsSessionFromConfigFile();

try {
  const result = await generateText({
    model: openai("gpt-5.4"),
    tools: toAISDKTools(ptools),
    stopWhen: stepCountIs(8),
    prompt: "Use the configured MCP servers to answer this.",
  });

  console.log(result.text);
} finally {
  await ptools.close();
}
```

Package docs:

- `@ptools/mcp-server`: MCP stdio server for MCP hosts
- `@ptools/agent-tools`: user-facing AI SDK session and adapter package
- `@ptools/core`: shared config and core types
- `@ptools/mcp-registry`: upstream MCP connection, discovery, and dispatch
- `@ptools/code-mode`: Code Mode search, schema, and execute orchestration
- `@ptools/executor`: local JavaScript execution host

See `packages/mcp-server/README.md` and `packages/agent-tools/README.md` for
the alpha user guides.
