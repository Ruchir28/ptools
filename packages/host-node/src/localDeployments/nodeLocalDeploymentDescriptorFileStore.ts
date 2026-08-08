/**
 * @file Filesystem persistence for local deployment descriptors.
 *
 * This module owns the on-disk catalog layout, schema decoding, and atomic JSON
 * publication. It deliberately does not decide whether a deployment may be
 * created or configured, nor whether its referenced state directory is safe.
 */
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect, Schema } from "effect";
import {
  NodeLocalDeploymentDescriptor,
  type NodeLocalDeploymentDescriptor as NodeLocalDeploymentDescriptorType,
} from "./contracts/nodeLocalDeploymentDescriptor.js";
import {
  NodeDeploymentName,
  type NodeDeploymentName as NodeDeploymentNameType,
} from "./contracts/nodeDeploymentName.js";
import {
  NodeLocalDeploymentCatalogError,
  catalogError,
  catalogMutationError,
  isMissingFileError,
} from "./nodeLocalDeploymentCatalogError.js";

/** Stable namespace beneath PTOOLS_HOME where descriptors are discoverable. */
export const NODE_LOCAL_DEPLOYMENT_CATALOG_DIRECTORY = "node-deployments";
const DESCRIPTOR_FILE = "deployment.json";

/** Reads and validates one descriptor, preserving absence as `undefined`. */
export const readOptionalNodeLocalDeploymentDescriptor = (
  root: string,
  name: NodeDeploymentNameType,
): Effect.Effect<
  NodeLocalDeploymentDescriptorType | undefined,
  NodeLocalDeploymentCatalogError
> =>
  Effect.gen(function* () {
    const path = descriptorPath(root, name);
    const text = yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (cause) =>
        catalogError(`Unable to read local Node deployment "${name}".`, cause),
    }).pipe(
      Effect.catch((error) =>
        isMissingFileError(error.cause) ? Effect.void : Effect.fail(error),
      ),
    );
    if (text === undefined) return undefined;

    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (cause) =>
        catalogError(`Deployment descriptor ${path} is not valid JSON.`, cause),
    });
    const descriptor = yield* Schema.decodeUnknownEffect(
      NodeLocalDeploymentDescriptor,
    )(parsed).pipe(
      Effect.mapError((cause) =>
        catalogError(`Unable to read local Node deployment "${name}".`, cause),
      ),
    );
    if (descriptor.name !== name) {
      return yield* new NodeLocalDeploymentCatalogError({
        message: `Deployment descriptor name ${descriptor.name} does not match catalog name ${name}.`,
      });
    }
    return descriptor;
  });

/** Requires one descriptor and reports a typed missing-catalog failure. */
export const readNodeLocalDeploymentDescriptor = (
  root: string,
  name: NodeDeploymentNameType,
): Effect.Effect<
  NodeLocalDeploymentDescriptorType,
  NodeLocalDeploymentCatalogError
> =>
  readOptionalNodeLocalDeploymentDescriptor(root, name).pipe(
    Effect.flatMap((descriptor) =>
      descriptor === undefined
        ? Effect.fail(
            catalogError(`Unable to read local Node deployment "${name}".`, {
              code: "ENOENT",
            }),
          )
        : Effect.succeed(descriptor),
    ),
  );

/** Reads every schema-valid catalog entry in canonical deployment-name order. */
export const listStoredNodeLocalDeploymentDescriptors = (
  root: string,
): Effect.Effect<
  ReadonlyArray<NodeLocalDeploymentDescriptorType>,
  NodeLocalDeploymentCatalogError
> =>
  Effect.gen(function* () {
    const directory = join(root, NODE_LOCAL_DEPLOYMENT_CATALOG_DIRECTORY);
    const entries = yield* Effect.tryPromise({
      try: () => readdir(directory, { withFileTypes: true }),
      catch: (cause) =>
        catalogError("Unable to list local Node deployments.", cause),
    }).pipe(
      Effect.catch((error) =>
        isMissingFileError(error.cause)
          ? Effect.succeed([])
          : Effect.fail(error),
      ),
    );
    const descriptors = yield* Effect.forEach(
      entries.filter((entry) => entry.isDirectory()),
      (entry) =>
        decodeStoredName(entry.name).pipe(
          Effect.flatMap((name) =>
            readNodeLocalDeploymentDescriptor(root, name),
          ),
        ),
    );
    return descriptors.sort((a, b) => a.name.localeCompare(b.name));
  });

/**
 * Encodes one descriptor and atomically renames a user-only temporary file so
 * readers cannot observe partial JSON during create or configure.
 */
export const writeNodeLocalDeploymentDescriptor = (
  root: string,
  descriptor: NodeLocalDeploymentDescriptorType,
): Effect.Effect<void, NodeLocalDeploymentCatalogError> =>
  Effect.gen(function* () {
    const path = descriptorPath(root, descriptor.name);
    const temporary = yield* Effect.sync(() => `${path}.${randomUUID()}.tmp`);
    yield* Effect.tryPromise({
      try: () => mkdir(dirname(path), { recursive: true, mode: 0o700 }),
      catch: catalogMutationError,
    });
    const encoded = yield* Schema.encodeEffect(NodeLocalDeploymentDescriptor)(
      descriptor,
    ).pipe(Effect.mapError(catalogMutationError));
    yield* Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () =>
          writeFile(temporary, `${JSON.stringify(encoded, null, 2)}\n`, {
            mode: 0o600,
            flag: "wx",
          }),
        catch: catalogMutationError,
      });
      yield* Effect.tryPromise({
        try: () => rename(temporary, path),
        catch: catalogMutationError,
      });
    }).pipe(
      // A successful rename moves the temporary directory entry to `path`, so
      // its old name is already absent and this forced removal is a no-op. If
      // writing or renaming fails, the same finalizer removes any temporary
      // file left behind instead of accumulating abandoned descriptor drafts.
      Effect.ensuring(
        Effect.promise(() => rm(temporary, { force: true })).pipe(
          Effect.ignore,
        ),
      ),
    );
  });

const descriptorPath = (root: string, name: NodeDeploymentNameType) =>
  join(root, NODE_LOCAL_DEPLOYMENT_CATALOG_DIRECTORY, name, DESCRIPTOR_FILE);

const decodeStoredName = (value: string) =>
  Schema.decodeUnknownEffect(NodeDeploymentName)(value).pipe(
    Effect.mapError((cause) =>
      catalogError(`Invalid local Node deployment name "${value}".`, cause),
    ),
  );
