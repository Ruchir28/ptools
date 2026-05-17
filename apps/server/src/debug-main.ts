import { Effect, Either } from "effect";

async function main() {
  const { runServer } = await import("./main.js");
  
  const result = await Effect.runPromise(
    Effect.either(runServer(process.argv.slice(2), process.env, process.cwd()))
  );
  
  if (Either.isLeft(result)) {
    const err = result.left;
    console.error("FAILED WITH TAG:", typeof err === "object" && err !== null && "_tag" in err ? err._tag : "unknown");
    console.error("FULL ERROR:", JSON.stringify(err, null, 2));
    process.exit(1);
  }
  
  console.error("Server running...");
}

main().catch((cause: unknown) => {
  console.error("THROWN:", typeof cause);
  console.error("MESSAGE:", cause instanceof Error ? cause.message : String(cause));
  console.error("STACK:", cause instanceof Error ? cause.stack : "no stack");
  process.exit(1);
});
