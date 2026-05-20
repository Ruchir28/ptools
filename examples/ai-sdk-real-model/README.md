# AI SDK real model example

This example runs the `@ptools/agent-tools` AI SDK adapter with a real model.
It uses `csv-demo.ptools.json` to connect a local stdio MCP server for the
CSV at `data/demo-sales.csv`, then asks the model to discover the dataset
tools, fetch only the schemas it needs, inspect the data shape, choose columns
from observed metadata, and execute compact calculations through Code Mode.

## Run with Vercel AI Gateway

```bash
AI_GATEWAY_API_KEY=... pnpm --filter @ptools/example-ai-sdk-real-model start
```

Optional:

```bash
AI_GATEWAY_MODEL=openai/gpt-5.4-mini pnpm --filter @ptools/example-ai-sdk-real-model start
```

## Run with OpenRouter

Put this in `.env` inside this example folder:

```bash
OPENROUTER_API_KEY=...
```

Then run:

```bash
pnpm --filter @ptools/example-ai-sdk-real-model start
```

Optional:

```bash
OPENROUTER_MODEL=openai/gpt-4o-mini pnpm --filter @ptools/example-ai-sdk-real-model start
```

## Run with OpenAI directly

```bash
OPENAI_API_KEY=... PTOOLS_AI_PROVIDER=openai pnpm --filter @ptools/example-ai-sdk-real-model start
```

Optional:

```bash
OPENAI_MODEL=gpt-5.4-mini PTOOLS_AI_PROVIDER=openai pnpm --filter @ptools/example-ai-sdk-real-model start
```

## Custom prompt

```bash
pnpm --filter @ptools/example-ai-sdk-real-model start -- --prompt-file ./prompt.txt
```

## Custom ptools config

```bash
pnpm --filter @ptools/example-ai-sdk-real-model start -- --config ./my-ptools.config.json
```

The older fixture echo config is still available for minimal smoke tests:

```bash
pnpm --filter @ptools/example-ai-sdk-real-model start -- --config ./fixture.ptools.json
```
