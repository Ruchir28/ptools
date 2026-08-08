/**
 * @file Persisted, non-secret locator for one local Node deployment.
 *
 * The descriptor connects a catalog name to the infrastructure facts that must
 * remain stable while the deployment runs: one fixed loopback port, one complete
 * state root, and an optional Deno executable override. It contains no process
 * generation, readiness state, credentials, hostId, or user authentication.
 * Those values belong to runtime ownership or request boundaries.
 */
import { isAbsolute, normalize } from "node:path";
import { Schema } from "effect";
import { NodeDeploymentName } from "./nodeDeploymentName.js";

/** Product-selected port used by the lazily created `default` deployment. */
export const DEFAULT_NODE_CONTROL_PLANE_PORT = 19_876;

/** Canonical public origin corresponding to the default deployment port. */
export const DEFAULT_NODE_PUBLIC_ORIGIN = `http://127.0.0.1:${DEFAULT_NODE_CONTROL_PLANE_PORT}`;

/** Valid TCP port for the deployment-owned loopback control-plane listener. */
export const NodeControlPlanePort = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  Schema.brand("NodeControlPlanePort"),
);
export type NodeControlPlanePort = Schema.Schema.Type<
  typeof NodeControlPlanePort
>;

/** Rejects relative and non-canonical aliases before paths become lock domains. */
const canonicalAbsolutePath = Schema.makeFilter(
  (value: string) =>
    value.length > 0 && isAbsolute(value) && normalize(value) === value,
  { expected: "a normalized absolute filesystem path" },
);

/**
 * Complete normalized state root shared by this deployment's control-plane and
 * actor daemons. Each daemon still owns distinct files beneath this root.
 */
export const NodeDeploymentStateDirectory = Schema.String.pipe(
  Schema.check(canonicalAbsolutePath),
  Schema.brand("NodeDeploymentStateDirectory"),
);
export type NodeDeploymentStateDirectory = Schema.Schema.Type<
  typeof NodeDeploymentStateDirectory
>;

/**
 * Stable schema-versioned locator persisted under the known deployment catalog.
 * `OptionFromOptionalKey` keeps absence functional after decoding while writing
 * an ordinary optional JSON property at the disk boundary.
 */
export const NodeLocalDeploymentDescriptor = Schema.Struct({
  version: Schema.Literal(1),
  name: NodeDeploymentName,
  controlPlanePort: NodeControlPlanePort,
  stateDirectory: NodeDeploymentStateDirectory,
  denoExecutableOverride: Schema.OptionFromOptionalKey(
    Schema.String.pipe(
      Schema.check(Schema.isTrimmed()),
      Schema.check(Schema.isMinLength(1)),
    ),
  ),
});
export type NodeLocalDeploymentDescriptor = Schema.Schema.Type<
  typeof NodeLocalDeploymentDescriptor
>;

/** Derives the only accepted public origin shape from trusted descriptor data. */
export const nodeControlPlanePublicOrigin = (
  port: NodeControlPlanePort,
): string => `http://127.0.0.1:${port}`;
