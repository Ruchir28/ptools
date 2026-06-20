import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CodeExecutor,
  ExecutorRuntimeError,
  ExecutorStartError,
  ExecutorTimeoutError,
  InvalidExecutorCode,
  makeExecuteRequest,
} from "@ptools/executor";
import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import { LocalSandboxExecutorLayer } from "../src/executor/localExecutor.js";
import { resolveDenoSandboxRuntimeConfig } from "../src/executor/denoSandboxProcess.js";
import {
  decodeSandboxMessage,
  MAX_SANDBOX_FRAME_BYTES,
} from "../src/executor/sandboxProtocol.js";

const hasDeno = (() => {
  try {
    execFileSync("deno", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("host-node sandbox protocol", () => {
  it("rejects malformed and oversized frames", async () => {
    await expect(
      Effect.runPromise(decodeSandboxMessage("not json")),
    ).rejects.toThrow();
    await expect(
      Effect.runPromise(
        decodeSandboxMessage("x".repeat(MAX_SANDBOX_FRAME_BYTES + 1)),
      ),
    ).rejects.toThrow();
  });

  it("ships a self-contained worker with the shared kernel", async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const source = await readFile(
      resolve(root, "dist/executor/sandbox-worker.js"),
      "utf8",
    );
    expect(source).toContain("makeSandboxKernel");
    expect(source).not.toContain("@ptools/");
    expect(source).not.toMatch(/from ["']effect["']/);
  });

  it("fails layer acquisition with an actionable start error", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        CodeExecutor.pipe(
          Effect.provide(
            LocalSandboxExecutorLayer({
              denoExecutable: "/definitely/missing/ptools-deno",
            }),
          ),
        ),
      ),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(ExecutorStartError);
      expect(result.left.message).toContain(
        "Install Deno, set DENO_BIN, or pass denoExecutable",
      );
    }
  });

  it("uses explicit denoExecutable before DENO_BIN", async () => {
    await withEnvironment(
      { DENO_BIN: "/definitely/missing/deno-from-env" },
      async () => {
        await expect(
          Effect.runPromise(
            resolveDenoSandboxRuntimeConfig({ denoExecutable: "deno" }),
          ),
        ).resolves.toEqual({ denoExecutable: "deno" });
      },
    );
  });

  it("fails fast when an explicit DENO_BIN is unavailable", async () => {
    await withEnvironment(
      { DENO_BIN: "/definitely/missing/deno-from-env" },
      async () => {
        const result = await Effect.runPromise(
          Effect.either(resolveDenoSandboxRuntimeConfig()),
        );
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          expect(result.left.message).toContain("using DENO_BIN");
        }
      },
    );
  });

  it.skipIf(process.platform === "win32")(
    "detects the canonical Deno home installation before PATH",
    async () => {
      const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
      const deno = resolve(root, "node_modules/deno/deno");
      const home = await mkdtemp(resolve(tmpdir(), "ptools-deno-home-"));
      const canonicalDirectory = resolve(home, ".deno/bin");
      const canonicalExecutable = resolve(canonicalDirectory, "deno");
      await mkdir(canonicalDirectory, { recursive: true });
      await symlink(deno, canonicalExecutable);

      try {
        await withEnvironment(
          { DENO_BIN: undefined, HOME: home, PATH: "" },
          async () => {
            await expect(
              Effect.runPromise(resolveDenoSandboxRuntimeConfig()),
            ).resolves.toEqual({ denoExecutable: canonicalExecutable });
          },
        );
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );
});

describe.skipIf(!hasDeno)("restricted Deno sandbox", () => {
  it("executes async code, globals, provider calls, and logs", async () => {
    const result = await run({
      code: `async () => {
        console.log("running");
        return { value: await fixture.double({ value: input }) };
      }`,
      globals: { input: 21 },
      providers: [
        {
          name: "fixture",
          fns: {
            double: (input) =>
              Effect.succeed((input as { readonly value: number }).value * 2),
          },
        },
      ],
    });
    expect(result.value).toEqual({ value: 42 });
    expect(result.logs[0]?.message).toBe("running");
  });

  it("correlates concurrent provider calls that complete out of order", async () => {
    const result = await run({
      code: "async () => Promise.all([fixture.echo('slow'), fixture.echo('fast')])",
      providers: [
        {
          name: "fixture",
          fns: {
            echo: (input) =>
              Effect.promise(
                () =>
                  new Promise((resolve) =>
                    setTimeout(() => resolve(input), input === "slow" ? 20 : 0),
                  ),
              ),
          },
        },
      ],
    });
    expect(result.value).toEqual(["slow", "fast"]);
  });

  it("reports calls that were still pending when Deno code returned", async () => {
    const result = await run({
      code: `async () => {
        void fixture.touch(null);
        return "done";
      }`,
      providers: [
        {
          name: "fixture",
          fns: {
            touch: () =>
              Effect.promise(
                () => new Promise((resolve) => setTimeout(resolve, 10)),
              ),
          },
        },
      ],
    });
    expect(result.value).toBe("done");
    expect(result.warnings).toEqual([
      {
        code: "ProviderCallPendingAtReturn",
        callId: "0",
        provider: "fixture",
        tool: "touch",
        outcome: "succeeded",
      },
    ]);
  });

  it("returns provider failures to generated code", async () => {
    const result = await run({
      code: `async () => {
        try { await fixture.fail(null); }
        catch (error) { return { name: error.name, message: error.message }; }
      }`,
      providers: [
        {
          name: "fixture",
          fns: { fail: () => Effect.fail("fixture failure") },
        },
      ],
    });
    expect(result.value).toEqual({ name: "Error", message: "fixture failure" });
  });

  it("maps invalid code and uncaught runtime failures", async () => {
    const invalid = await runEither({ code: "42" });
    expect(Either.isLeft(invalid) && invalid.left).toBeInstanceOf(
      InvalidExecutorCode,
    );

    const runtime = await runEither({
      code: 'async () => { throw new Error("uncaught"); }',
    });
    expect(Either.isLeft(runtime) && runtime.left).toBeInstanceOf(
      ExecutorRuntimeError,
    );
  });

  it("times out and terminates the subprocess", async () => {
    const result = await runEither({
      code: "async () => await new Promise(() => {})",
      timeoutMs: 50,
    });
    expect(Either.isLeft(result) && result.left).toBeInstanceOf(
      ExecutorTimeoutError,
    );
  });

  it.each([
    ["filesystem read", 'await Deno.readTextFile("/etc/hosts")'],
    ["filesystem write", 'await Deno.writeTextFile("./ptools-denied", "x")'],
    ["network", 'await fetch("https://example.com")'],
    ["environment", 'Deno.env.get("PATH")'],
    ["subprocess", 'await new Deno.Command("echo", { args: ["x"] }).output()'],
    ["FFI", 'Deno.dlopen("/definitely/missing", {})'],
    ["system information", "Deno.hostname()"],
    ["remote imports", 'await import("https://example.com/mod.js")'],
  ])("denies %s access in the real subprocess", async (_name, operation) => {
    const result = await run({
      code: `async () => {
        try {
          ${operation};
          return { denied: false };
        } catch (error) {
          return { denied: true, name: error.name, message: error.message };
        }
      }`,
    });
    expect(result.value).toEqual(expect.objectContaining({ denied: true }));
  });
});

const run = (request: Parameters<typeof makeExecuteRequest>[0]) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const executor = yield* CodeExecutor;
      return yield* executor.execute(makeExecuteRequest(request));
    }).pipe(Effect.provide(LocalSandboxExecutorLayer())),
  );

const runEither = (request: Parameters<typeof makeExecuteRequest>[0]) =>
  Effect.runPromise(
    Effect.either(
      Effect.gen(function* () {
        const executor = yield* CodeExecutor;
        return yield* executor.execute(makeExecuteRequest(request));
      }).pipe(Effect.provide(LocalSandboxExecutorLayer())),
    ),
  );

const withEnvironment = async <A>(
  updates: Readonly<Record<string, string | undefined>>,
  run: () => Promise<A>,
): Promise<A> => {
  const previous = Object.fromEntries(
    Object.keys(updates).map((name) => [name, process.env[name]]),
  );
  try {
    for (const [name, value] of Object.entries(updates)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    return await run();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
};
