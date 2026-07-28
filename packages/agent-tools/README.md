# @ptools/agent-tools

Use ptools from an AI SDK model. This package adapts a provided Code Mode
client into AI SDK tools. Host-specific packages such as `@ptools/host-node`
load config, connect MCP servers, and create that client.

## Install

```bash
npm install @ptools/agent-tools @ptools/host-node
```

You also need an AI SDK model provider package for your app, such as
`@ai-sdk/openai`.

## Configure MCP Servers

When using the Node host, create `ptools.config.json` in the directory where
your app starts:

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

## Use With AI SDK

```ts
import { generateText, stepCountIs } from "ai";
import { openai } from "@ai-sdk/openai";
import { startEmbeddedNodeHost } from "@ptools/host-node";
import { makePtoolsSession } from "@ptools/agent-tools";
import { toAISDKTools } from "@ptools/agent-tools/ai-sdk";

const host = await startEmbeddedNodeHost({ hostId: "my-app" });
await host.call({ operation: "configure", input: { config: authoredConfig } });
await host.call({
  operation: "configure_secrets",
  input: { secrets: explicitlySelectedSecrets },
});
const ptools = makePtoolsSession(host.codeMode);

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

`@ptools/host-node` does not read config files or the process environment.
Applications that start from a file decode it with `@ptools/config`, normalize
relative stdio working directories against that file, and submit only referenced
secret values through the two explicit Host operations above.

## Session Lifecycle

Create one session for the part of your app that needs MCP-backed tools, reuse
it for model calls, and always close it when that work is finished:

```ts
const host = await startEmbeddedNodeHost({ hostId: "my-app" });
const ptools = makePtoolsSession(host.codeMode);

try {
  const tools = toAISDKTools(ptools);
  // pass tools to generateText or streamText
} finally {
  await ptools.close();
}
```

`close()` delegates to the provided Code Mode client handle. For the embedded Node host,
it closes local ingress and releases that ingress's daemon lease.

## What Tools The Model Sees

The AI SDK adapter exposes four Code Mode tools with a `ptools_` prefix:

- `ptools_search_providers`: find upstream MCP provider namespaces behind
  ptools.
- `ptools_search`: find callable actions for a task query.
- `ptools_get_tool_schema`: fetch full schemas and TypeScript declarations for
  selected action `toolId`s.
- `ptools_execute`: run generated JavaScript against the discovered provider
  APIs, which is useful for multi-step calls and reducing intermediate results
  before returning a compact answer.

Use provider discovery when the model is unsure what namespace exists, then use
action search with task words:

```txt
ptools_search_providers({ query: "github" })
ptools_search({ provider: "github", query: "issue" })
ptools_get_tool_schema({ toolIds: ["github.create_issue"] })
ptools_execute({ code: "..." })
```

Provider words in `ptools_search.query` are only context. A provider-only action
query such as `ptools_search({ query: "github" })` intentionally does not list
every GitHub action; add action terms like `issue`, `repository`, or `pull
request`.

The upstream MCP tool names stay inside the host registry. Generated code uses
sanitized provider APIs, such as `github.createIssue(...)`, and ptools dispatches
those calls back to the original MCP servers.

## Troubleshooting

Config bootstrap failures: explicitly decode the intended authored file and call
`configure`; constructors perform no project/file discovery.

`${env:NAME}` missing: provide only the referenced value through
`configure_secrets`. Product entrypoints such as the CLI can explicitly select
those values from their environment.

MCP server command fails: run the configured `command` and `args` manually and
check that server package's documentation. Stdio MCP servers must start and
respond to MCP discovery.

Model calls fail: inspect `await ptools.diagnostics()` before the model run to
see which providers and Code Mode tools are available.

## Status And Roadmap

This alpha focuses on the AI SDK path. Direct OpenAI and Anthropic adapters are
planned follow-ups after the installable package path is stable.
