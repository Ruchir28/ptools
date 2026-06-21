/**
 * @file Renders the per-execution `generated-code.js` Dynamic Worker module.
 *
 * This trusted build-side helper turns an already-prepared
 * `SandboxExecutionPayload` into ESM source text. The output module is loaded
 * beside the fixed Cloudflare kernel adapter for exactly one execution and
 * contains only the generated function expression plus binding names — never
 * provider implementations, credentials, MCP clients, or host callbacks.
 */
import { ExecutorProtocolError, type SandboxExecutionPayload } from "@ptools/executor";
import { injectableBindingKeys } from "@ptools/executor/sandbox";
import { Effect } from "effect";

/**
 * Renders the per-execution ESM module loaded beside the fixed Cloudflare
 * kernel adapter. This module contains generated user code and binding names
 * only; provider implementations and trusted host callbacks are never embedded.
 */
export const renderGeneratedCodeModule = (
  payload: SandboxExecutionPayload,
): Effect.Effect<string, ExecutorProtocolError> =>
  Effect.try({
    try: () => renderGeneratedCodeModuleUnsafe(payload),
    catch: (cause) =>
      new ExecutorProtocolError({
        message: "Failed to render Dynamic Worker generated-code module",
        cause,
      }),
  });

const renderGeneratedCodeModuleUnsafe = (
  payload: SandboxExecutionPayload,
): string => {
  const bindingKeys = injectableBindingKeys(payload.globals, payload.providers);

  for (const key of bindingKeys) {
    assertSafeIdentifier(key);
  }

  return `
export const bindingKeys = ${JSON.stringify(bindingKeys)};

export default async function runGenerated(__bindings) {
  const { ${bindingKeys.join(", ")} } = __bindings;
  const generatedFunction = (${payload.code});

  if (typeof generatedFunction !== "function") {
    const error = new Error(
      "Executor code must evaluate to a function expression. Use async () => { ... } or () => { ... }.",
    );
    error.code = "InvalidExecutorCode";
    throw error;
  }

  return await generatedFunction();
}
`;
};

const identifierPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

const assertSafeIdentifier = (key: string): void => {
  if (!identifierPattern.test(key)) {
    throw new Error(`Invalid generated-code binding identifier: ${key}`);
  }
};
