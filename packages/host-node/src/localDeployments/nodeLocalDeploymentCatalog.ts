/**
 * @file Public workflows for the persistent local deployment catalog.
 *
 * The catalog maps a deployment name to its fixed listener port, normalized
 * state root, and optional Deno override. This module owns create, configure,
 * resolve, and list behavior. Descriptor JSON persistence and state-directory
 * policy live in focused sibling modules so those boundaries can be reviewed
 * independently.
 *
 * Catalog mutations assume one CLI writer. Descriptor publication is atomic,
 * while running control-plane and actor daemons separately retain native
 * ownership locks inside the selected state root.
 */
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { Effect, Option, Schema } from "effect";
import {
  DEFAULT_NODE_CONTROL_PLANE_PORT,
  NodeControlPlanePort,
  NodeLocalDeploymentDescriptor,
  type NodeLocalDeploymentDescriptor as NodeLocalDeploymentDescriptorType,
} from "./contracts/nodeLocalDeploymentDescriptor.js";
import {
  DEFAULT_NODE_DEPLOYMENT_NAME,
  NodeDeploymentName,
  type NodeDeploymentName as NodeDeploymentNameType,
} from "./contracts/nodeDeploymentName.js";
import {
  NodeLocalDeploymentCatalogError,
  catalogError,
} from "./nodeLocalDeploymentCatalogError.js";
import {
  NODE_LOCAL_DEPLOYMENT_CATALOG_DIRECTORY,
  listStoredNodeLocalDeploymentDescriptors,
  readNodeLocalDeploymentDescriptor,
  readOptionalNodeLocalDeploymentDescriptor,
  writeNodeLocalDeploymentDescriptor,
} from "./nodeLocalDeploymentDescriptorFileStore.js";
import {
  assertNodeDeploymentStateDirectoryUnique,
  decodeNodeDeploymentStateDirectory,
  ensureNodeDeploymentStateDirectory,
  validateNodeDeploymentStateDirectoryReference,
} from "./nodeLocalDeploymentStateDirectory.js";

export { NodeLocalDeploymentCatalogError } from "./nodeLocalDeploymentCatalogError.js";

/** Authored CLI input for explicitly provisioning a non-default deployment. */
export interface CreateNodeLocalDeploymentOptions {
  /** Canonical name; `default` is reserved for lazy conventional creation. */
  readonly name: string;
  /** Required fixed public listener port; no random-port fallback is allowed. */
  readonly port: number;
  /** Optional immutable state root; otherwise derived beneath PTOOLS_HOME. */
  readonly stateDirectory?: string;
  /** Optional process executable override persisted in the descriptor. */
  readonly denoExecutable?: string;
}

/** Mutable settings accepted only while the complete deployment is quiescent. */
export interface ConfigureNodeLocalDeploymentOptions {
  /** Replacement fixed listener port; omission preserves the current value. */
  readonly port?: number;
  /** Replacement executable override; mutually exclusive with reset. */
  readonly denoExecutable?: string;
  /** Removes an authored executable override and restores normal resolution. */
  readonly useDefaultDeno?: boolean;
}

/**
 * Resolves the catalog root before any deployment-specific state path is known.
 * A non-empty `PTOOLS_HOME` must be absolute; otherwise `~/.ptools` is used.
 */
export const resolvePtoolsHome = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): Effect.Effect<string, NodeLocalDeploymentCatalogError> =>
  Effect.try({
    try: () => {
      const selected = env.PTOOLS_HOME?.trim();
      const path =
        selected === undefined || selected === ""
          ? join(home, ".ptools")
          : selected;
      if (!isAbsolute(path))
        throw new Error("PTOOLS_HOME must be an absolute path.");
      return normalize(path);
    },
    catch: (cause) => catalogError("Unable to resolve PTOOLS_HOME.", cause),
  });

/**
 * Resolves one descriptor by canonical name. Only `default` may be created
 * implicitly, and only when the caller explicitly enables first-use creation.
 */
export const resolveNodeLocalDeployment = (
  authoredName: string,
  options: { readonly createDefaultIfMissing?: boolean } = {},
): Effect.Effect<
  NodeLocalDeploymentDescriptorType,
  NodeLocalDeploymentCatalogError
> =>
  Effect.gen(function* () {
    const name = yield* decodeName(authoredName);
    const root = yield* resolvePtoolsHome();
    const found = yield* readValidatedOptionalDescriptor(root, name);
    if (found !== undefined) return found;
    if (
      name === DEFAULT_NODE_DEPLOYMENT_NAME &&
      options.createDefaultIfMissing === true
    ) {
      return yield* ensureDefaultNodeLocalDeployment(root);
    }
    return yield* new NodeLocalDeploymentCatalogError({
      message:
        name === DEFAULT_NODE_DEPLOYMENT_NAME
          ? `Local Node deployment "${name}" does not exist. Start it once with: ptools node deployment start ${name}`
          : `Local Node deployment "${name}" does not exist. Create it with: ptools node deployment create ${name} --port <port>`,
    });
  });

/**
 * Creates one explicit non-default deployment after validating its authored
 * values, state-root existence, and uniqueness across catalog descriptors.
 */
export const createNodeLocalDeployment = (
  options: CreateNodeLocalDeploymentOptions,
): Effect.Effect<
  NodeLocalDeploymentDescriptorType,
  NodeLocalDeploymentCatalogError
> =>
  Effect.gen(function* () {
    const name = yield* decodeName(options.name);
    if (name === DEFAULT_NODE_DEPLOYMENT_NAME) {
      return yield* new NodeLocalDeploymentCatalogError({
        message:
          'The conventional "default" deployment is created lazily; create requires a non-default name.',
      });
    }
    const port = yield* decodePort(options.port);
    const root = yield* resolvePtoolsHome();
    const stateDirectory = yield* decodeNodeDeploymentStateDirectory(
      options.stateDirectory ??
        join(root, NODE_LOCAL_DEPLOYMENT_CATALOG_DIRECTORY, name, "state"),
    );
    const deno = yield* decodeDeno(options.denoExecutable);

    yield* assertDescriptorAbsent(root, name);
    yield* ensureNodeDeploymentStateDirectory(stateDirectory);
    yield* assertNodeDeploymentStateDirectoryUnique(root, stateDirectory);
    yield* validateNodeDeploymentStateDirectoryReference(name, stateDirectory);

    const descriptor = NodeLocalDeploymentDescriptor.make({
      version: 1,
      name,
      controlPlanePort: port,
      stateDirectory,
      denoExecutableOverride: deno,
    });
    yield* writeNodeLocalDeploymentDescriptor(root, descriptor);
    return descriptor;
  });

/**
 * Updates mutable infrastructure only after the caller proves both deployment
 * daemons quiescent. Moving the state root requires a separate migration flow.
 */
export const configureNodeLocalDeployment = <E, R>(
  nameInput: string,
  options: ConfigureNodeLocalDeploymentOptions,
  assertQuiescent: (
    descriptor: NodeLocalDeploymentDescriptorType,
  ) => Effect.Effect<void, E, R>,
): Effect.Effect<
  NodeLocalDeploymentDescriptorType,
  NodeLocalDeploymentCatalogError | E,
  R
> =>
  Effect.gen(function* () {
    if (
      options.useDefaultDeno === true &&
      options.denoExecutable !== undefined
    ) {
      return yield* new NodeLocalDeploymentCatalogError({
        message:
          "--deno-executable and --use-default-deno are mutually exclusive.",
      });
    }
    const name = yield* decodeName(nameInput);
    const root = yield* resolvePtoolsHome();
    const current = yield* readValidatedDescriptor(root, name);
    yield* assertQuiescent(current);
    const port =
      options.port === undefined
        ? current.controlPlanePort
        : yield* decodePort(options.port);
    const deno =
      options.useDefaultDeno === true
        ? Option.none<string>()
        : options.denoExecutable === undefined
          ? current.denoExecutableOverride
          : yield* decodeDeno(options.denoExecutable);
    const next = NodeLocalDeploymentDescriptor.make({
      ...current,
      controlPlanePort: port,
      denoExecutableOverride: deno,
    });
    yield* writeNodeLocalDeploymentDescriptor(root, next);
    return next;
  });

/** Lists validated descriptors without implying that deployments are running. */
export const listNodeLocalDeployments = (): Effect.Effect<
  ReadonlyArray<NodeLocalDeploymentDescriptorType>,
  NodeLocalDeploymentCatalogError
> =>
  Effect.gen(function* () {
    const root = yield* resolvePtoolsHome();
    const descriptors = yield* listStoredNodeLocalDeploymentDescriptors(root);
    yield* Effect.forEach(
      descriptors,
      (descriptor) =>
        validateNodeDeploymentStateDirectoryReference(
          descriptor.name,
          descriptor.stateDirectory,
        ),
      { discard: true },
    );
    return descriptors;
  });

/** Lazily publishes the conventional descriptor after full state validation. */
const ensureDefaultNodeLocalDeployment = (
  root: string,
): Effect.Effect<
  NodeLocalDeploymentDescriptorType,
  NodeLocalDeploymentCatalogError
> =>
  Effect.gen(function* () {
    const existing = yield* readValidatedOptionalDescriptor(
      root,
      DEFAULT_NODE_DEPLOYMENT_NAME,
    );
    if (existing !== undefined) return existing;
    const stateDirectory = yield* decodeNodeDeploymentStateDirectory(
      join(root, NODE_LOCAL_DEPLOYMENT_CATALOG_DIRECTORY, "default", "state"),
    );
    yield* ensureNodeDeploymentStateDirectory(stateDirectory);
    yield* assertNodeDeploymentStateDirectoryUnique(root, stateDirectory);
    yield* validateNodeDeploymentStateDirectoryReference(
      DEFAULT_NODE_DEPLOYMENT_NAME,
      stateDirectory,
    );
    const descriptor = NodeLocalDeploymentDescriptor.make({
      version: 1,
      name: DEFAULT_NODE_DEPLOYMENT_NAME,
      controlPlanePort: NodeControlPlanePort.make(
        DEFAULT_NODE_CONTROL_PLANE_PORT,
      ),
      stateDirectory,
      denoExecutableOverride: Option.none(),
    });
    yield* writeNodeLocalDeploymentDescriptor(root, descriptor);
    return descriptor;
  });

/** Reads a descriptor and validates the state authority it references. */
const readValidatedOptionalDescriptor = (
  root: string,
  name: NodeDeploymentNameType,
): Effect.Effect<
  NodeLocalDeploymentDescriptorType | undefined,
  NodeLocalDeploymentCatalogError
> =>
  Effect.gen(function* () {
    const descriptor = yield* readOptionalNodeLocalDeploymentDescriptor(
      root,
      name,
    );
    if (descriptor === undefined) return undefined;
    yield* validateNodeDeploymentStateDirectoryReference(
      descriptor.name,
      descriptor.stateDirectory,
    );
    return descriptor;
  });

/** Requires a descriptor and validates the state authority it references. */
const readValidatedDescriptor = (
  root: string,
  name: NodeDeploymentNameType,
): Effect.Effect<
  NodeLocalDeploymentDescriptorType,
  NodeLocalDeploymentCatalogError
> =>
  Effect.gen(function* () {
    const descriptor = yield* readNodeLocalDeploymentDescriptor(root, name);
    yield* validateNodeDeploymentStateDirectoryReference(
      descriptor.name,
      descriptor.stateDirectory,
    );
    return descriptor;
  });

/** Prevents explicit create from overwriting an existing deployment name. */
const assertDescriptorAbsent = (
  root: string,
  name: NodeDeploymentNameType,
): Effect.Effect<void, NodeLocalDeploymentCatalogError> =>
  readValidatedOptionalDescriptor(root, name).pipe(
    Effect.flatMap((descriptor) =>
      descriptor === undefined
        ? Effect.void
        : Effect.fail(
            new NodeLocalDeploymentCatalogError({
              message: `Local Node deployment "${name}" already exists.`,
            }),
          ),
    ),
  );

const decodeName = (value: string) =>
  Schema.decodeUnknownEffect(NodeDeploymentName)(value).pipe(
    Effect.mapError((cause) =>
      catalogError(`Invalid local Node deployment name "${value}".`, cause),
    ),
  );

const decodePort = (value: number) =>
  Schema.decodeUnknownEffect(NodeControlPlanePort)(value).pipe(
    Effect.mapError((cause) =>
      catalogError(`Invalid Node control-plane port ${value}.`, cause),
    ),
  );

const decodeDeno = (value: string | undefined) =>
  value === undefined
    ? Effect.succeed(Option.none<string>())
    : value.trim() === ""
      ? Effect.fail(catalogError("Deno executable override must not be empty."))
      : Effect.succeed(Option.some(value.trim()));
