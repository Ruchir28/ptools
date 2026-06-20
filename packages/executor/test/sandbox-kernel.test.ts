import { Effect, Schema } from "effect";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HostToSandboxMessage,
  invokeProviderCall,
  SandboxToHostMessage,
} from "../src/index.js";
import {
  injectableBindingKeys,
  makeSandboxKernel,
  type SandboxKernelExecution,
} from "../src/sandbox/index.js";

describe("sandbox protocol", () => {
  it("decodes both directional message variants", async () => {
    await expect(
      Effect.runPromise(
        Schema.decodeUnknown(HostToSandboxMessage)({
          _tag: "Execute",
          payload: { code: "async () => null", globals: {}, providers: [] },
        }),
      ),
    ).resolves.toMatchObject({ _tag: "Execute" });

    await expect(
      Effect.runPromise(
        Schema.decodeUnknown(SandboxToHostMessage)({
          _tag: "ProviderCall",
          call: { callId: "1", provider: "fixture", tool: "echo", input: null },
        }),
      ),
    ).resolves.toMatchObject({ _tag: "ProviderCall" });
  });

  it("rejects unknown tags and malformed calls", async () => {
    await expect(
      Effect.runPromise(
        Schema.decodeUnknown(SandboxToHostMessage)({ _tag: "Unknown" }),
      ),
    ).rejects.toThrow();
    await expect(
      Effect.runPromise(
        Schema.decodeUnknown(SandboxToHostMessage)({
          _tag: "ProviderCall",
          call: { provider: "fixture", tool: "echo", input: null },
        }),
      ),
    ).rejects.toThrow();
  });

  it("requires valid warning outcome shapes on completion", async () => {
    await expect(
      Effect.runPromise(
        Schema.decodeUnknown(SandboxToHostMessage)({
          _tag: "Complete",
          completion: {
            ok: true,
            value: "done",
            logs: [],
            warnings: [
              {
                code: "ProviderCallPendingAtReturn",
                callId: "0",
                provider: "fixture",
                tool: "touch",
                outcome: "failed",
              },
            ],
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("preserves callId through host provider dispatch", async () => {
    const result = await Effect.runPromise(
      invokeProviderCall(
        [{ name: "fixture", fns: { echo: (input) => Effect.succeed(input) } }],
        { callId: "call-7", provider: "fixture", tool: "echo", input: "ok" },
      ),
    );
    expect(result).toEqual({ ok: true, callId: "call-7", value: "ok" });
  });
});

describe("sandbox binding keys", () => {
  it("returns globals, providers, and console in loader order", () => {
    expect(
      injectableBindingKeys({ alpha: 1, beta: 2 }, [
        { name: "github", tools: ["createIssue"] },
        { name: "linear", tools: ["createIssue"] },
      ]),
    ).toEqual(["alpha", "beta", "github", "linear", "console"]);
  });
});

describe("shared sandbox kernel", () => {
  it("requires a host bridge when the kernel is initialized", () => {
    expect(() =>
      makeSandboxKernel({ invokeProvider: undefined as never }),
    ).toThrow("SandboxHostBridge.invokeProvider must be a function");
  });

  it("keeps the shared kernel source free of host runtime dependencies", async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const sources = await Promise.all(
      [
        "index.ts",
        "kernel/index.ts",
        "kernel/bindings.ts",
        "kernel/kernel.ts",
        "kernel/types.ts",
      ].map((file) => readFile(resolve(root, "src/sandbox", file), "utf8")),
    );
    const executableSource = sources
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    expect(executableSource).not.toMatch(
      /(?:from\s+|import\s*\()["'](?:@ptools\/|effect(?:\/|["'])|node:|cloudflare:)/,
    );
    expect(executableSource).not.toMatch(/\b(?:Deno|Effect)\s*\./);
  });

  it("fails fast when loader binding keys drift from the kernel plan", async () => {
    const kernel = makeSandboxKernel({
      invokeProvider: async (call) => ({
        ok: true,
        callId: call.callId,
      }),
    });

    await expect(
      kernel.execute({
        program: () => "done",
        bindingKeys: ["fixture"],
        globals: {},
        providers: [{ name: "fixture", tools: ["touch"] }],
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        message:
          'Sandbox loader binding keys do not match kernel binding plan: expected ["fixture", "console"], received ["fixture"]',
      },
      warnings: [],
    });
  });

  it("correlates concurrent provider calls that finish out of order", async () => {
    const seen: Array<string> = [];
    const kernel = makeSandboxKernel({
      invokeProvider: (call) =>
        new Promise((resolve) => {
          seen.push(call.callId);
          setTimeout(
            () => resolve({ ok: true, callId: call.callId, value: call.input }),
            call.input === "slow" ? 20 : 0,
          );
        }),
    });
    const result = await kernel.execute(
      withBindingKeys({
        program: async (bindings) => {
          const fixture = bindings.fixture as {
            readonly echo: (input: string) => Promise<string>;
          };
          return Promise.all([fixture.echo("slow"), fixture.echo("fast")]);
        },
        globals: {},
        providers: [{ name: "fixture", tools: ["echo"] }],
      }),
    );

    expect(seen).toEqual(["0", "1"]);
    expect(result).toMatchObject({
      ok: true,
      value: ["slow", "fast"],
      warnings: [],
    });
  });

  it("waits for unawaited calls and captures console output", async () => {
    let settled = false;
    const kernel = makeSandboxKernel({
      invokeProvider: (call) =>
        new Promise((resolve) =>
          setTimeout(() => {
            settled = true;
            resolve({ ok: true, callId: call.callId });
          }, 10),
        ),
    });
    const result = await kernel.execute(
      withBindingKeys({
        program: (bindings) => {
          const fixture = bindings.fixture as {
            readonly touch: (input: null) => Promise<void>;
          };
          const console = bindings.console as Console;
          void fixture.touch(null);
          console.log("started", { count: 1 });
          return "done";
        },
        globals: {},
        providers: [{ name: "fixture", tools: ["touch"] }],
      }),
    );

    expect(settled).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      value: "done",
      logs: [{ level: "log", message: 'started {"count":1}' }],
      warnings: [
        {
          code: "ProviderCallPendingAtReturn",
          callId: "0",
          provider: "fixture",
          tool: "touch",
          outcome: "succeeded",
        },
      ],
    });
  });

  it("reports failed calls that were pending when the program returned", async () => {
    const kernel = makeSandboxKernel({
      invokeProvider: (call) =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                ok: false,
                callId: call.callId,
                error: { name: "FixtureError", message: "late boom" },
              }),
            10,
          ),
        ),
    });
    const result = await kernel.execute(
      withBindingKeys({
        program: (bindings) => {
          const fixture = bindings.fixture as {
            readonly fail: (input: null) => Promise<void>;
          };
          void fixture.fail(null);
          return "done";
        },
        globals: {},
        providers: [{ name: "fixture", tools: ["fail"] }],
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      value: "done",
      warnings: [
        {
          code: "ProviderCallPendingAtReturn",
          callId: "0",
          provider: "fixture",
          tool: "fail",
          outcome: "failed",
          error: { name: "FixtureError", message: "late boom" },
        },
      ],
    });
  });

  it("serializes provider failures into one terminal completion", async () => {
    const kernel = makeSandboxKernel({
      invokeProvider: async (call) => ({
        ok: false,
        callId: call.callId,
        error: { name: "FixtureError", message: "boom" },
      }),
    });
    const result = await kernel.execute(
      withBindingKeys({
        program: async (bindings) => {
          const fixture = bindings.fixture as {
            readonly fail: (input: null) => Promise<void>;
          };
          await fixture.fail(null);
        },
        globals: {},
        providers: [{ name: "fixture", tools: ["fail"] }],
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { name: "FixtureError", message: "boom" },
      warnings: [],
    });
  });
});

const withBindingKeys = (
  execution: Omit<SandboxKernelExecution, "bindingKeys">,
): SandboxKernelExecution => ({
  ...execution,
  bindingKeys: injectableBindingKeys(execution.globals, execution.providers),
});
