/**
 * @file Canonical identity for one named local Node deployment.
 *
 * A deployment name is both user-facing CLI input and a directory segment in
 * the known deployment catalog. The deliberately narrow format gives each name
 * one spelling and prevents separators, traversal, whitespace aliases, and
 * case-folding collisions from selecting the same filesystem location.
 */
import { Schema } from "effect";

/** Validates the complete authored name instead of sanitizing unsafe input. */
const canonicalNodeDeploymentName = Schema.makeFilter(
  (value: string) =>
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 63,
  {
    expected:
      "1-63 lowercase ASCII letters/numbers separated by single hyphens",
  },
);

/**
 * Canonical, path-segment-safe name used to locate a descriptor in the catalog.
 * The brand ensures internal APIs receive a schema-validated name rather than
 * an arbitrary string.
 */
export const NodeDeploymentName = Schema.String.pipe(
  Schema.check(canonicalNodeDeploymentName),
  Schema.brand("NodeDeploymentName"),
);
export type NodeDeploymentName = Schema.Schema.Type<typeof NodeDeploymentName>;

/** Conventional deployment selected when callers do not author another name. */
export const DEFAULT_NODE_DEPLOYMENT_NAME = NodeDeploymentName.make("default");
