import { Data } from "effect";

/** Typed failure shared by catalog workflows and their filesystem helpers. */
export class NodeLocalDeploymentCatalogError extends Data.TaggedError(
  "NodeLocalDeploymentCatalogError",
)<{ readonly message: string; readonly cause?: unknown }> {}

/** Adds catalog context while preserving the original failure for diagnostics. */
export const catalogError = (message: string, cause?: unknown) =>
  new NodeLocalDeploymentCatalogError({ message, cause });

/** Recognizes native missing-file failures without widening other I/O errors. */
export const isMissingFileError = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === "ENOENT";

/** Gives descriptor publication failures one stable catalog-level message. */
export const catalogMutationError = (cause: unknown) =>
  cause instanceof NodeLocalDeploymentCatalogError
    ? cause
    : catalogError("Local Node deployment catalog mutation failed.", cause);
