import type {
  CapturedLog,
  LogLevel,
  RpcCallResponse,
  SandboxCompleteRequest,
  SerializedSandboxError,
} from "./types.js";

interface SandboxPayload {
  readonly code: string;
  readonly globals: Record<string, unknown>;
  readonly providers: ReadonlyArray<{
    readonly name: string;
    readonly tools: ReadonlyArray<string>;
  }>;
}

const logLevels: ReadonlyArray<LogLevel> = [
  "debug",
  "error",
  "info",
  "log",
  "warn",
];
const logs: Array<CapturedLog> = [];

for (const level of logLevels) {
  console[level] = (...args: ReadonlyArray<unknown>) => {
    logs.push({
      level,
      args: args.map(toJsonSafe),
      message: args.map(formatLogArg).join(" "),
    });
  };
}

try {
  const payload = readPayload();
  const { names, values } = createExecutionContext(payload);
  const execute = evaluateCode(payload.code);
  const value = await execute(names, values);

  await reportComplete({
    ok: true,
    value,
    logs,
  });
} catch (cause) {
  await reportComplete({
    ok: false,
    error: serializeUnknownError(cause),
    logs,
  });
  process.exitCode = 1;
}

function readPayload(): SandboxPayload {
  const rawPayload = readRequiredEnv("PTOOLS_EXECUTOR_PAYLOAD");
  delete process.env.PTOOLS_EXECUTOR_PAYLOAD;

  return JSON.parse(rawPayload) as SandboxPayload;
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined) {
    throw new Error(`Missing required sandbox environment variable: ${name}`);
  }

  return value;
}

function createExecutionContext(payload: SandboxPayload): {
  readonly names: ReadonlyArray<string>;
  readonly values: ReadonlyArray<unknown>;
} {
  const globals = cloneJsonObject(payload.globals);
  const names: Array<string> = [];
  const values: Array<unknown> = [];

  for (const [name, value] of Object.entries(globals)) {
    names.push(name);
    values.push(value);
  }

  for (const provider of payload.providers) {
    names.push(provider.name);
    values.push(createProviderProxy(provider));
  }

  return { names, values };
}

function cloneJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function createProviderProxy(provider: {
  readonly name: string;
  readonly tools: ReadonlyArray<string>;
}): Record<string, (input: unknown) => Promise<unknown>> {
  const proxy: Record<string, (input: unknown) => Promise<unknown>> = {};

  for (const tool of provider.tools) {
    proxy[tool] = async (input: unknown): Promise<unknown> =>
      callProviderTool(provider.name, tool, input);
  }

  return proxy;
}

async function callProviderTool(
  provider: string,
  tool: string,
  input: unknown,
): Promise<unknown> {
  const rpcUrl = readRequiredEnv("PTOOLS_EXECUTOR_RPC_URL");
  const token = readRequiredEnv("PTOOLS_EXECUTOR_RPC_TOKEN");
  const response = await fetch(`${rpcUrl}/call`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ provider, tool, input }),
  });

  const payload = (await response.json()) as RpcCallResponse;

  if (!response.ok || !payload.ok) {
    throw deserializeSandboxError(
      payload.ok
        ? {
            name: "RpcProtocolError",
            message: `RPC call failed with HTTP ${response.status}`,
            code: "RpcProtocolError",
          }
        : payload.error,
    );
  }

  return payload.value;
}

function evaluateCode(
  code: string,
): (
  names: ReadonlyArray<string>,
  values: ReadonlyArray<unknown>,
) => Promise<unknown> | unknown {
  let value: unknown;

  try {
    value = new Function(...["__code", "return (0, eval)(`(${__code})`);"])(
      code,
    );
  } catch (cause) {
    throw markInvalidCode(cause);
  }

  if (typeof value !== "function") {
    throw markInvalidCode(
      new Error("Executor code must evaluate to a function"),
    );
  }

  return (names, values) =>
    new Function(...names, "return (" + code + ");")(...values)();
}

async function reportComplete(body: SandboxCompleteRequest): Promise<void> {
  const rpcUrl = readRequiredEnv("PTOOLS_EXECUTOR_RPC_URL");
  const token = readRequiredEnv("PTOOLS_EXECUTOR_RPC_TOKEN");

  await fetch(`${rpcUrl}/complete`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function markInvalidCode(cause: unknown): Error {
  const error =
    cause instanceof Error ? cause : new Error(`Invalid executor code: ${cause}`);
  (error as Error & { code?: string }).code = "InvalidExecutorCode";

  return error;
}

function serializeUnknownError(cause: unknown): SerializedSandboxError {
  if (cause instanceof Error) {
    return {
      name: cause.name,
      message: cause.message,
      ...(cause.stack === undefined ? {} : { stack: cause.stack }),
      ...((cause as Error & { code?: string }).code === undefined
        ? {}
        : { code: (cause as Error & { code: string }).code }),
    };
  }

  return {
    message: String(cause),
  };
}

function deserializeSandboxError(error: SerializedSandboxError): Error {
  const result = new Error(error.message);

  if (error.name !== undefined) {
    result.name = error.name;
  }

  if (error.stack !== undefined) {
    result.stack = error.stack;
  }

  if (error.code !== undefined) {
    (result as Error & { code?: string }).code = error.code;
  }

  return result;
}

function formatLogArg(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toJsonSafe(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}
