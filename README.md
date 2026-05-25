# ptools

ptools turns many upstream MCP servers into one Code Mode tool surface. The
model sees a small set of tools for discovery and execution, while host-side
ptools keeps the original MCP registry, tool schemas, and dispatch path
authoritative.

The first installable alpha path is the AI SDK package:

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

- `@ptools/agent-tools`: user-facing AI SDK session and adapter package
- `@ptools/core`: shared config and core types
- `@ptools/mcp-registry`: upstream MCP connection, discovery, and dispatch
- `@ptools/code-mode`: Code Mode search, schema, and execute orchestration
- `@ptools/executor`: local JavaScript execution host

See `packages/agent-tools/README.md` for the alpha user guide.

