#!/usr/bin/env node
import { Effect } from "effect";
import { runServer } from "./server.js";

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
  await Effect.runPromise(
    runServer(process.argv.slice(2), process.env, process.cwd()),
  );
};

main().catch((cause: unknown) => {
  process.stderr.write(`${safeErrorMessage(cause)}\n`);
  process.exitCode = 1;
});
