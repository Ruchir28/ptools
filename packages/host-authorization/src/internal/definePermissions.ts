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
 * `values` feeds the runtime `HostPermission` schema. `catalog` lets policies
 * refer to permissions without repeating strings. Keeping both views derived
 * here prevents the runtime decoder and TypeScript policy values from drifting.
 */

/**
 * Author input: each domain has at least one action. The readonly tuple keeps
 * action names as literals instead of widening them to `string`.
 */
type PermissionDefinition = Readonly<
  Record<string, readonly [string, ...ReadonlyArray<string>]>
>;

/**
 * Converts every domain/action pair into its `"domain:action"` literal union.
 *
 * For `{ host: ["read", "execute"] }`, this becomes
 * `"host:read" | "host:execute"`.
 */
type PermissionValue<Definition extends PermissionDefinition> = {
  readonly [Domain in keyof Definition & string]: `${Domain}:${Definition[Domain][number] & string}`;
}[keyof Definition & string];

/**
 * Preserves the nested authoring shape while replacing each action with its
 * complete permission value. This is the type behind `HostPermissions.host.read`.
 */
type PermissionCatalog<Definition extends PermissionDefinition> = {
  readonly [Domain in keyof Definition]: {
    readonly [Action in Definition[Domain][number] & string]: `${Domain & string}:${Action}`;
  };
};

/** Both runtime views derived from the same literal permission declaration. */
export interface DefinedPermissions<Definition extends PermissionDefinition> {
  /** Flat values used to construct the exhaustive runtime permission schema. */
  readonly values: ReadonlyArray<PermissionValue<Definition>>;
  /** Nested typed lookup used by role definitions and authorization policies. */
  readonly catalog: PermissionCatalog<Definition>;
}

/**
 * Builds the flat schema values and nested policy catalog from one declaration.
 *
 * The `const` generic preserves the caller's literal domains and actions.
 * `Object.entries` necessarily erases those literal keys at runtime, so this
 * function uses broad mutable accumulators internally and performs the only
 * narrowing casts after every entry has been validated and assembled.
 */
export const definePermissions = <const Definition extends PermissionDefinition>(
  definition: Definition,
): DefinedPermissions<Definition> => {
  // `Object.entries` widens literal keys to strings. Keep that loss of type
  // precision local; callers still receive the exact mapped types above.
  const values: Array<string> = [];
  const catalog: Record<string, Readonly<Record<string, string>>> = {};

  for (const [domain, actions] of Object.entries(definition)) {
    // Colons are reserved as the domain/action separator. Rejecting them in
    // either component guarantees one unambiguous serialized permission value.
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
      const permission = `${domain}:${action}`;
      domainCatalog[action] = permission;
      values.push(permission);
    }

    // Freeze every nested domain before freezing the outer result so runtime
    // consumers cannot mutate one view and make it disagree with the other.
    catalog[domain] = Object.freeze(domainCatalog);
  }

  return Object.freeze({
    // These casts restore the literal relationship proven by the validated loop;
    // no cast is exposed to permission consumers.
    values: Object.freeze(values) as ReadonlyArray<PermissionValue<Definition>>,
    catalog: Object.freeze(catalog) as PermissionCatalog<Definition>,
  });
};

/** Enforces the delimiter invariant shared by domains and actions. */
const assertPermissionPart = (
  kind: "action" | "domain",
  value: string,
): void => {
  if (value.length === 0 || value.includes(":")) {
    throw new Error(
      `Permission ${kind} must be non-empty and must not contain ":": ${JSON.stringify(value)}.`,
    );
  }
};
