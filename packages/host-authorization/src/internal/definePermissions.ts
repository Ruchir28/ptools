/**
 * Internal permission-catalog derivation.
 *
 * Permissions are authored once as a nested literal object:
 *
 * ```ts
 * definePermissions({
 *   host: ["read", "execute"],
 *   members: ["manage"],
 * } as const)
 * ```
 *
 * From that one input this helper builds two views of the same vocabulary:
 *
 * ```txt
 * values  = ["host:read", "host:execute", "members:manage"]
 * catalog = {
 *   host: { read: "host:read", execute: "host:execute" },
 *   members: { manage: "members:manage" }
 * }
 * ```
 *
 * A namespace option adds one fixed leading component without changing the
 * code-facing catalog shape. For example, `{ namespace: "control-plane" }`
 * produces `"control-plane:hosts:create"` while retaining
 * `catalog.hosts.create`.
 *
 * `values` feeds the exhaustive runtime permission schema. `catalog` lets
 * policies refer to permissions without repeating strings. Deriving both views
 * here prevents runtime decoding and TypeScript policy values from drifting.
 */

/**
 * Author input: each domain has at least one action. The readonly tuple keeps
 * action names as literals instead of widening them to `string`.
 */
type PermissionDefinition = Readonly<
  Record<string, readonly [string, ...ReadonlyArray<string>]>
>;

/** Joins validated permission components into their serialized identifier. */
type PermissionValueFor<
  Namespace extends string | undefined,
  Domain extends string,
  Action extends string,
> = Namespace extends string
  ? `${Namespace}:${Domain}:${Action}`
  : `${Domain}:${Action}`;

/** Converts every domain/action pair into its serialized literal union. */
type PermissionValue<
  Definition extends PermissionDefinition,
  Namespace extends string | undefined,
> = {
  readonly [Domain in keyof Definition & string]: PermissionValueFor<
    Namespace,
    Domain,
    Definition[Domain][number] & string
  >;
}[keyof Definition & string];

/**
 * Preserves the nested authoring shape while replacing each action with its
 * complete permission value. This is the type behind values such as
 * `HostPermissions.host.read` and `ControlPlanePermissions.hosts.create`.
 */
type PermissionCatalog<
  Definition extends PermissionDefinition,
  Namespace extends string | undefined,
> = {
  readonly [Domain in keyof Definition]: {
    readonly [Action in Definition[Domain][number] &
      string]: PermissionValueFor<Namespace, Domain & string, Action>;
  };
};

/** Both runtime views derived from the same literal permission declaration. */
export interface DefinedPermissions<
  Definition extends PermissionDefinition,
  Namespace extends string | undefined = undefined,
> {
  /** Flat values used to construct the exhaustive runtime permission schema. */
  readonly values: ReadonlyArray<PermissionValue<Definition, Namespace>>;
  /** Nested typed lookup used by role definitions and authorization policies. */
  readonly catalog: PermissionCatalog<Definition, Namespace>;
}

/** Optional fixed prefix for a namespaced permission vocabulary. */
interface PermissionNamespace<Namespace extends string> {
  readonly namespace: Namespace;
}

/**
 * Builds flat schema values and a nested policy catalog from one declaration.
 * Without a namespace, identifiers have the form `domain:action`.
 */
export function definePermissions<
  const Definition extends PermissionDefinition,
>(definition: Definition): DefinedPermissions<Definition>;

/**
 * Builds a namespaced vocabulary with identifiers in the form
 * `namespace:domain:action` while preserving `catalog.domain.action` access.
 */
export function definePermissions<
  const Definition extends PermissionDefinition,
  const Namespace extends string,
>(
  definition: Definition,
  options: PermissionNamespace<Namespace>,
): DefinedPermissions<Definition, Namespace>;

export function definePermissions(
  definition: PermissionDefinition,
  options?: PermissionNamespace<string>,
): DefinedPermissions<PermissionDefinition, string | undefined> {
  // `Object.entries` widens literal keys to strings. Keep that loss of type
  // precision local; callers still receive the exact mapped types above.
  const values: Array<string> = [];
  const catalog: Record<string, Readonly<Record<string, string>>> = {};
  const namespace = options?.namespace;

  if (namespace !== undefined) {
    assertPermissionPart("namespace", namespace);
  }

  for (const [domain, actions] of Object.entries(definition)) {
    // Colons are reserved as component separators. Rejecting them guarantees
    // one unambiguous serialized permission value.
    assertPermissionPart("domain", domain);

    const domainCatalog: Record<string, string> = {};
    for (const action of actions) {
      assertPermissionPart("action", action);
      // Duplicate actions would collapse to one object property while leaving
      // duplicate flat values, so fail before publishing inconsistent views.
      if (action in domainCatalog) {
        throw new Error(
          `Permission domain ${JSON.stringify(domain)} repeats action ${JSON.stringify(action)}.`,
        );
      }

      // This is the only place the canonical wire/storage identifier is formed.
      const permission =
        namespace === undefined
          ? `${domain}:${action}`
          : `${namespace}:${domain}:${action}`;
      domainCatalog[action] = permission;
      values.push(permission);
    }

    // Freeze every nested domain before freezing the outer result so runtime
    // consumers cannot mutate one view and make it disagree with the other.
    catalog[domain] = Object.freeze(domainCatalog);
  }

  return Object.freeze({
    // Overloads restore the literal relationships proven by the validated loop;
    // no cast is exposed to permission consumers.
    values: Object.freeze(values),
    catalog: Object.freeze(catalog),
  }) as DefinedPermissions<PermissionDefinition, string | undefined>;
}

/** Enforces the delimiter invariant shared by every identifier component. */
const assertPermissionPart = (
  kind: "action" | "domain" | "namespace",
  value: string,
): void => {
  if (value.length === 0 || value.includes(":")) {
    throw new Error(
      `Permission ${kind} must be non-empty and must not contain ":": ${JSON.stringify(value)}.`,
    );
  }
};
