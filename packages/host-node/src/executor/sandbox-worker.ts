/**
 * @file Deno Sandbox Worker Entrypoint
 *
 * This file is the platform-specific wrapper that executes inside the restricted
 * Deno subprocess. It bridges the platform-agnostic Shared Sandbox Kernel to the
 * trusted host Node.js process using standard I/O (`stdin`/`stdout`) NDJSON streams.
 *
 * ### Execution Lifecycle
 *
 * 1. **Handshake**: Reads the first NDJSON frame from `stdin` containing the `Execute`
 *    payload (user code, globals, and provider manifests).
 * 2. **Compilation (Deno Program Loader)**: Compiles the user's code string into a
 *    callable `SandboxProgram` function using scoped runtime compilation (`new Function`).
 * 3. **Bridge Creation (Deno Provider Invoker)**: Sets up a pending-Promise correlation
 *    table and creates a `SandboxProviderInvoker` that serializes provider calls to `stdout`
 *    and listens on `stdin` for incoming results.
 * 4. **Kernel Initialization**: Constructs the Shared Sandbox Kernel with the
 *    required stdio host bridge, then executes the compiled program.
 * 5. **Completion**: Writes the final `SandboxCompletion` envelope back to `stdout`
 *    and shuts down the subprocess.
 */

import {
  makeSandboxKernel,
  type SandboxProgram,
  type SandboxProviderInvoker,
} from "@ptools/executor/sandbox";
import type {
  HostToSandboxMessage,
  SandboxExecutionPayload,
  SandboxProviderCallResult,
  SandboxToHostMessage,
} from "@ptools/executor";

/**
 * Represents the Deno global runtime namespace.
 * Used to access stdin/stdout streams for NDJSON communication.
 */
type DenoRuntime = {
  readonly stdin: { readonly readable: ReadableStream<Uint8Array> };
  readonly stdout: { readonly writable: WritableStream<Uint8Array> };
};

/**
 * Tracks a pending tool call from the sandbox to the host.
 * Holds the resolve/reject callbacks to resume execution once the host responds.
 */
interface PendingProviderCall {
  readonly resolve: (result: SandboxProviderCallResult) => void;
  readonly reject: (error: Error) => void;
}

const deno = (globalThis as typeof globalThis & { readonly Deno: DenoRuntime })
  .Deno;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

const readLines = async function* (): AsyncGenerator<string> {
  const reader = deno.stdin.readable.getReader();
  let buffered = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        yield buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
      }
    }
    buffered += decoder.decode();
    if (buffered.length > 0) throw new Error("Incomplete stdin protocol frame");
  } finally {
    reader.releaseLock();
  }
};

const writer = deno.stdout.writable.getWriter();
let writeQueue = Promise.resolve();
const write = (message: SandboxToHostMessage): Promise<void> => {
  writeQueue = writeQueue.then(() =>
    writer.write(encoder.encode(`${JSON.stringify(message)}\n`)),
  );
  return writeQueue;
};

const lines = readLines();
const first = await lines.next();
if (first.done) throw new Error("Sandbox stdin closed before Execute");
const executeMessage = JSON.parse(first.value) as HostToSandboxMessage;
if (executeMessage._tag !== "Execute") {
  throw new Error("First sandbox message must be Execute");
}

/**
 * RPC Correlation Table
 *
 * This Map keeps track of active, in-flight provider calls initiated by the sandbox program
 * that are currently executing on the trusted host.
 *
 * Because standard I/O is asynchronous and non-blocking, we cannot simply block the thread while
 * waiting for a tool response. Instead, we return an unresolved `Promise` to the running program,
 * store its `resolve` and `reject` handles in this map under a unique `callId`, and wait for the
 * host to asynchronously send back the matching result.
 */
const pendingCalls = new Map<string, PendingProviderCall>();

/**
 * Sandboxed RPC Client Bridge (invokeProvider)
 *
 * This function satisfies the `SandboxProviderInvoker` contract required by the Shared Sandbox Kernel.
 * Its job is to intercept tool calls (such as file reads, database queries, or external tool execution)
 * made by the sandboxed program, serialize them into a standard protocol message, write them across the
 * process isolation boundary via standard output (`stdout`), and suspend the calling execution.
 *
 * ### How the execution suspension works:
 * 1. It creates and returns a raw, unresolved JavaScript `Promise` to the sandbox kernel.
 * 2. It saves the `resolve` and `reject` callbacks of this Promise in the `pendingCalls` map
 *    indexed by a unique `callId`.
 * 3. It serializes the call metadata into an NDJSON packet and writes it to standard out.
 * 4. The user's sandboxed program automatically halts (awaits) at this promise boundary, allowing other
 *    concurrent background operations or logs to run while the host processes the operation.
 */
const invokeProvider: SandboxProviderInvoker = (call) =>
  new Promise((resolve, reject) => {
    if (pendingCalls.has(call.callId)) {
      reject(new Error(`Duplicate pending provider callId: ${call.callId}`));
      return;
    }
    pendingCalls.set(call.callId, { resolve, reject });
    void write({ _tag: "ProviderCall", call }).catch((cause: unknown) => {
      pendingCalls.delete(call.callId);
      reject(cause instanceof Error ? cause : new Error(String(cause)));
    });
  });

/**
 * Background Event & Message Loop (resultLoop)
 *
 * This async immediately-invoked function expression (IIFE) runs concurrently in the background.
 * It is responsible for continuously listening on standard input (`stdin`) for messages arriving
 * from the trusted Node.js host.
 *
 * ### How the execution resumption works:
 * 1. It streams incoming data lines from `stdin` (parsed as `HostToSandboxMessage`).
 * 2. It expects `ProviderCallResult` envelopes containing the outcome of real tool execution.
 * 3. It uses the incoming `callId` to locate the suspended promise's callbacks in the `pendingCalls` map.
 * 4. It removes the entry from the map and calls `pending.resolve(result)`.
 * 5. This instantly resolves the Promise that the sandboxed program was awaiting, seamlessly
 *    resuming user code execution with the real data returned by the host.
 */
const resultLoop = (async () => {
  for await (const line of lines) {
    const message = JSON.parse(line) as HostToSandboxMessage;
    if (message._tag !== "ProviderCallResult") {
      throw new Error(`Unexpected host message: ${message._tag}`);
    }
    const pending = pendingCalls.get(message.result.callId);
    if (pending === undefined) {
      throw new Error(
        `Unknown provider result callId: ${message.result.callId}`,
      );
    }
    pendingCalls.delete(message.result.callId);
    pending.resolve(message.result);
  }
  if (pendingCalls.size > 0) {
    throw new Error("Host stdin closed with pending provider calls");
  }
})();

let program: SandboxProgram;
try {
  program = loadDenoSandboxProgram(executeMessage.payload);
} catch (cause) {
  program = () => {
    throw cause;
  };
}
const kernel = makeSandboxKernel({ invokeProvider });
const completion = await kernel.execute({
  program,
  globals: executeMessage.payload.globals,
  providers: executeMessage.payload.providers,
});
await write({ _tag: "Complete", completion });
await writer.close();
void resultLoop.catch(() => undefined);

/**
 * Compiles the raw generated user code string into a callable `SandboxProgram` function.
 *
 * This is the Deno-specific implementation of the Program Loader. It uses runtime compilation
 * (`new Function`) inside the restricted subprocess to create a scoped wrapper function.
 *
 * To prevent global scope pollution and maintain strict lexical scope isolation:
 * 1. It extracts all variable names to inject (globals, providers, and console).
 * 2. It compiles a wrapper function that accepts a single `__bindings` parameter.
 * 3. Inside the wrapper, it destructures `__bindings` into local variables.
 * 4. It wraps the user's arrow function in parentheses and executes it immediately.
 *
 * When the returned `SandboxProgram` is invoked by the Shared Kernel, JavaScript's lexical
 * scoping ensures that the user's code can resolve all injected variables locally.
 *
 * @param payload The execution payload containing the user's code, globals, and provider manifests.
 * @returns A callable `SandboxProgram` function compiled inside the sandbox.
 */
function loadDenoSandboxProgram(
  payload: SandboxExecutionPayload,
): SandboxProgram {
  const names = [
    ...Object.keys(payload.globals),
    ...payload.providers.map((provider) => provider.name),
    "console",
  ];
  let execute: SandboxProgram;
  try {
    execute = new Function(
      "__bindings",
      `const { ${names.join(", ")} } = __bindings; return (${payload.code})();`,
    ) as SandboxProgram;
  } catch (cause) {
    throw markInvalidCode(cause);
  }
  try {
    const value = new Function(`return (${payload.code});`)() as unknown;
    if (typeof value !== "function") {
      throw new Error(
        "Executor code must evaluate to a function expression. Use async () => { ... } or () => { ... }.",
      );
    }
  } catch (cause) {
    throw markInvalidCode(cause);
  }
  return execute;
}

function markInvalidCode(cause: unknown): Error {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  (error as Error & { code?: string }).code = "InvalidExecutorCode";
  return error;
}
