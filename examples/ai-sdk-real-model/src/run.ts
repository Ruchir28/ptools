import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createNodeCodeModeClientFromConfigFile } from "@ptools/host-node";
import { makePtoolsSession } from "@ptools/agent-tools";
import { toAISDKTools } from "@ptools/agent-tools/ai-sdk";
import { generateText, stepCountIs } from "ai";

const SYSTEM_PROMPT = `\
You are a data analysis agent with access to MCP-backed provider APIs through ptools Code Mode.

You have three tools. Start every task by calling ptools_search with no arguments to enumerate all available providers and tools — never search with domain keywords from the user request before you have seen what providers exist. \
Use ptools_get_tool_schema to fetch the full interface for any tool you plan to call. \
Use ptools_execute to run JavaScript against the discovered providers — provider namespaces \
returned by search are injected as globals inside an async arrow function expression, \
for example: async () => { const rows = await myProvider.someAction({ ... }); return rows; }.

Work incrementally: inspect what data looks like before running aggregations, and only request \
the columns and rows you actually need. Perform filtering, aggregation, and control flow inside \
execute code so that raw results stay in the execution environment rather than filling your context. \
If an early inspection changes your understanding, adapt and run a focused follow-up step.

Return grounded answers backed by exact figures from observed tool results.`;

const main = async (): Promise<void> => {
  loadDotEnvFile();

  const configPath = resolveConfigPath();
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  const modelId = process.env.OPENROUTER_MODEL ?? "openai/gpt-5.4-mini";
  const prompt = readFlag("--prompt-file")
    ? readFileSync(readFlag("--prompt-file")!, "utf8")
    : "What drove the most revenue this period — which product and which seller led it, and how did performance vary across regions?";
  const ptools = makePtoolsSession(
    await createNodeCodeModeClientFromConfigFile(configPath),
  );

  try {
    const diagnostics = await ptools.diagnostics();

    if (diagnostics.length > 0) {
      console.log("diagnostics:", JSON.stringify(diagnostics, null, 2));
    }

    console.log(`model: openrouter/${modelId}`);
    console.log(`config: ${configPath}`);
    console.log("");

    const result = await generateText({
      model: createOpenRouter({ apiKey }).chat(modelId),
      system: SYSTEM_PROMPT,
      tools: toAISDKTools(ptools),
      maxRetries: 2,
      stopWhen: stepCountIs(12),
      prompt,
    });

    console.log("answer:\n" + result.text);
    console.log("");

    for (const [index, step] of result.steps.entries()) {
      console.log(`--- step ${index + 1}`);

      for (const call of step.toolCalls) {
        console.log(`  call  ${call.toolName}  ${JSON.stringify(call.input)}`);
      }

      for (const res of step.toolResults) {
        console.log(`  result ${res.toolName}  ${JSON.stringify(res.output)}`);
      }

      for (const part of step.content) {
        if (isToolErrorPart(part)) {
          console.error(
            `  error  ${part.toolName}  ${formatError(part.error)}`,
          );
        }
      }
    }
  } finally {
    await ptools.close();
  }
};

const resolveConfigPath = (): string => {
  const cliPath = readFlag("--config") ?? "csv-demo.ptools.json";
  const cwd = fileURLToPath(new URL("..", import.meta.url));

  return isAbsolute(cliPath) ? cliPath : resolve(cwd, cliPath);
};

const readFlag = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);

  return index === -1 ? undefined : process.argv[index + 1];
};

const loadDotEnvFile = (): void => {
  const envPath = resolve(
    fileURLToPath(new URL("..", import.meta.url)),
    ".env",
  );

  try {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith("#")) continue;

      const sep = trimmed.indexOf("=");

      if (sep === -1) continue;

      const key = trimmed.slice(0, sep).trim();
      const raw = trimmed.slice(sep + 1).trim();
      const value =
        (raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'"))
          ? raw.slice(1, -1)
          : raw;

      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

type ToolErrorPart = {
  readonly type: "tool-error";
  readonly toolName: string;
  readonly input: unknown;
  readonly error: unknown;
};

const isToolErrorPart = (part: unknown): part is ToolErrorPart =>
  typeof part === "object" &&
  part !== null &&
  "type" in part &&
  (part as ToolErrorPart).type === "tool-error";

const formatError = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : JSON.stringify(error);

await main();
