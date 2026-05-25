# @ptools/agent-tools

Use ptools from an AI SDK model. This package loads your `ptools.config.json`,
connects the configured MCP servers, creates a Code Mode session, and exposes
that session as AI SDK tools.

## Install

```bash
npm install @ptools/agent-tools
```

You also need an AI SDK model provider package for your app, such as
`@ai-sdk/openai`.

## Configure MCP Servers

Create `ptools.config.json` in the directory where your app starts:

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

Pass an explicit config path when the file is not named `ptools.config.json`:

```ts
const ptools = await createPtoolsSessionFromConfigFile(
  "./config/ptools.config.json",
);
```

## Session Lifecycle

Create one session for the part of your app that needs MCP-backed tools, reuse
it for model calls, and always close it when that work is finished:

```ts
const ptools = await createPtoolsSessionFromConfigFile();

try {
  const tools = toAISDKTools(ptools);
  // pass tools to generateText or streamText
} finally {
  await ptools.close();
}
```

`close()` shuts down the Effect runtime and releases MCP server connections.

## What Tools The Model Sees

The AI SDK adapter exposes four Code Mode tools with a `ptools_` prefix:

- `ptools_search_providers`: find configured MCP provider namespaces.
- `ptools_search`: find callable actions for a task query.
- `ptools_get_tool_schema`: fetch full schemas and TypeScript declarations for
  selected action `toolId`s.
- `ptools_execute`: run generated JavaScript against the discovered provider
  APIs.

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

`ptools.config.json` not found: create the file in your app working directory,
or pass an explicit path to `createPtoolsSessionFromConfigFile()`.

`${env:NAME}` missing: export the environment variable before starting your app.
ptools fails fast when an explicit env reference cannot be resolved.

MCP server command fails: run the configured `command` and `args` manually and
check that server package's documentation. Stdio MCP servers must start and
respond to MCP discovery.

Model calls fail: inspect `await ptools.diagnostics()` before the model run to
see which providers and Code Mode tools are available.

## Status And Roadmap

This alpha focuses on the AI SDK path. Direct OpenAI and Anthropic adapters are
planned follow-ups after the installable package path is stable.
