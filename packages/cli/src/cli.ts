#!/usr/bin/env node
import { createNodeCodeModeClientFromConfigFile } from "@ptools/host-node";
import { serveMcpWithCodeModeClient } from "@ptools/mcp-server";
import { Effect } from "effect";

const usage = `Usage:
  ptools mcp serve --host node [--config <path>]

Options:
  --host node       Host implementation to use. Only node is available today.
  --config <path>  Optional ptools config path. Defaults to Node host discovery.
`;

const safeErrorMessage = (cause: unknown): string => {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }

  if (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    typeof cause._tag === "string"
  ) {
    return cause._tag;
  }

  return String(cause);
};

const main = async (): Promise<void> => {
  const argv = argvWithoutPassthroughSeparator(process.argv.slice(2));
  const command = parseCommand(argv);

  switch (command.kind) {
    case "help":
      process.stdout.write(usage);
      return;
    case "mcp-serve": {
      const client = await createNodeCodeModeClientFromConfigFile(
        command.configPath,
        {
          cwd: process.cwd(),
          env: process.env,
        },
      );

      await Effect.runPromise(serveMcpWithCodeModeClient(client));
      return;
    }
  }
};

type CliCommand =
  | { readonly kind: "help" }
  | {
      readonly kind: "mcp-serve";
      readonly configPath?: string;
    };

/** pnpm/npm pass a literal `--` through to scripts; OpenCode uses the same shape. */
const argvWithoutPassthroughSeparator = (
  argv: ReadonlyArray<string>,
): ReadonlyArray<string> => argv.filter((arg) => arg !== "--");

const parseCommand = (argv: ReadonlyArray<string>): CliCommand => {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return { kind: "help" };
  }

  const [area, action, ...rest] = argv;

  if (area !== "mcp" || action !== "serve") {
    throw new Error(`Unknown ptools command.\n\n${usage}`);
  }

  const options = parseServeOptions(rest);

  if (options.host !== "node") {
    throw new Error(`Unsupported MCP host: ${options.host}`);
  }

  return {
    kind: "mcp-serve",
    ...(options.configPath === undefined
      ? {}
      : { configPath: options.configPath }),
  };
};

const parseServeOptions = (
  argv: ReadonlyArray<string>,
): { readonly host: string; readonly configPath?: string } => {
  let host = "node";
  let configPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--host":
        host = readFlagValue(argv, index, "--host");
        index += 1;
        break;
      case "--config":
        configPath = readFlagValue(argv, index, "--config");
        index += 1;
        break;
      default:
        throw new Error(`Unknown option for ptools mcp serve: ${arg}`);
    }
  }

  return {
    host,
    ...(configPath === undefined ? {} : { configPath }),
  };
};

const readFlagValue = (
  argv: ReadonlyArray<string>,
  index: number,
  name: string,
): string => {
  const value = argv[index + 1];

  if (value === undefined || value.trim() === "" || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}.`);
  }

  return value;
};

main().catch((cause: unknown) => {
  process.stderr.write(`${safeErrorMessage(cause)}\n`);
  process.exitCode = 1;
});
