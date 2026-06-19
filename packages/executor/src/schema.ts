/**
 * Public compatibility entrypoint for executor wire schemas.
 *
 * Sandbox protocol DTOs live together under `./sandbox/protocol.ts`; they are
 * re-exported here because trusted host packages consume them from the main
 * `@ptools/executor` entrypoint. The dependency-free sandbox runtime imports
 * these contracts as erased TypeScript types only.
 */
export * from "./sandbox/protocol.js";
