/**
 * @file Validation and placement policy for local deployment state roots.
 *
 * A state root is the shared authority for daemon locks, metadata, and runtime
 * state. This module owns path normalization, alias detection, directory
 * creation, and validation that referenced state roots still exist.
 */
import { mkdir, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { Effect, Schema } from "effect";
import { NodeDeploymentStateDirectory } from "./contracts/nodeLocalDeploymentDescriptor.js";
import { NodeDeploymentName } from "./contracts/nodeDeploymentName.js";
import {
  NodeLocalDeploymentCatalogError,
  catalogError,
  catalogMutationError,
  isMissingFileError,
} from "./nodeLocalDeploymentCatalogError.js";
import {
  NODE_LOCAL_DEPLOYMENT_CATALOG_DIRECTORY,
  readOptionalNodeLocalDeploymentDescriptor,
} from "./nodeLocalDeploymentDescriptorFileStore.js";

/** Normalizes an absolute authored path before applying the branded contract. */
export const decodeNodeDeploymentStateDirectory = (value: string) =>
  !isAbsolute(value)
    ? Effect.fail(
        catalogError(
          `Invalid Node deployment state directory ${value}: path must be absolute.`,
        ),
      )
    : Schema.decodeUnknownEffect(NodeDeploymentStateDirectory)(
        normalize(value),
      ).pipe(
        Effect.mapError((cause) =>
          catalogError(
            `Invalid Node deployment state directory ${value}.`,
            cause,
          ),
        ),
      );

/** Creates the private state root before real-path and filesystem validation. */
export const ensureNodeDeploymentStateDirectory = (
  stateDirectory: string,
): Effect.Effect<void, NodeLocalDeploymentCatalogError> =>
  Effect.tryPromise({
    try: () => mkdir(stateDirectory, { recursive: true, mode: 0o700 }),
    catch: catalogMutationError,
  });

/** Verifies that a descriptor still points to an existing state root. */
export const validateNodeDeploymentStateDirectoryReference = (
  deploymentName: string,
  stateDirectory: string,
): Effect.Effect<void, NodeLocalDeploymentCatalogError> =>
  Effect.tryPromise({
    try: () => realpath(stateDirectory),
    catch: (cause) =>
      catalogError(
        `Unable to resolve state directory for deployment "${deploymentName}".`,
        cause,
      ),
  }).pipe(Effect.asVoid);

/**
 * Compares real paths across known descriptors so two deployment names cannot
 * intentionally select one state/lock/database authority through path aliases.
 *
 * Checking that the requested state directory exists cannot show whether a
 * deployment already owns it: the directory may exist before any deployment
 * claims it and has no reverse owner record. For example, when creating a
 * deployment with `/tmp/shared-state`, the catalog may already contain:
 *
 *   alpha/descriptor.json -> { stateDirectory: "/tmp/shared-state" }
 *
 * Catalog descriptors are therefore the ownership authority. This scans every
 * known descriptor and compares its resolved path with the requested path.
 */
export const assertNodeDeploymentStateDirectoryUnique = (
  root: string,
  stateDirectory: string,
): Effect.Effect<void, NodeLocalDeploymentCatalogError> =>
  Effect.gen(function* () {
    const candidateRealPath = yield* Effect.tryPromise({
      try: () => realpath(stateDirectory),
      catch: catalogMutationError,
    }).pipe(Effect.map(normalize));
    const directory = join(root, NODE_LOCAL_DEPLOYMENT_CATALOG_DIRECTORY);
    const entries = yield* Effect.tryPromise({
      try: () => readdir(directory, { withFileTypes: true }),
      catch: catalogMutationError,
    }).pipe(
      Effect.catch((error) =>
        isMissingFileError(error.cause)
          ? Effect.succeed([])
          : Effect.fail(error),
      ),
    );
    yield* Effect.forEach(
      entries,
      (entry) => {
        if (!entry.isDirectory()) return Effect.void;
        return Schema.decodeUnknownEffect(NodeDeploymentName)(entry.name).pipe(
          Effect.matchEffect({
            onFailure: () => Effect.void,
            onSuccess: (name) =>
              readOptionalNodeLocalDeploymentDescriptor(root, name).pipe(
                Effect.flatMap((descriptor) => {
                  if (descriptor === undefined) return Effect.void;
                  return Effect.tryPromise({
                    try: () => realpath(descriptor.stateDirectory),
                    catch: catalogMutationError,
                  }).pipe(
                    Effect.map(normalize),
                    Effect.flatMap((existingRealPath) =>
                      existingRealPath === candidateRealPath
                        ? Effect.fail(
                            new NodeLocalDeploymentCatalogError({
                              message: `State directory ${stateDirectory} is already owned by deployment "${descriptor.name}".`,
                            }),
                          )
                        : Effect.void,
                    ),
                  );
                }),
              ),
          }),
        );
      },
      { discard: true },
    );
  });
