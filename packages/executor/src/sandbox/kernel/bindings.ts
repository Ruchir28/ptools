/**
 * Shared sandbox binding plan.
 *
 * Platform loaders own compilation, while the shared kernel owns runtime
 * binding materialization. This module is the contract between those two
 * phases: both derive their work from the same execution-specific binding
 * plan instead of maintaining independent lists of injectable names.
 */
export type SandboxBindingSource = "global" | "provider" | "kernel";

export interface SandboxBindingDescriptor {
  readonly key: string;
  readonly source: SandboxBindingSource;
}

export type SandboxBindingProviderManifest = {
  readonly name: string;
  readonly tools: ReadonlyArray<string>;
};

export const fixedKernelBindingDescriptors = [
  { key: "console", source: "kernel" },
] as const satisfies ReadonlyArray<SandboxBindingDescriptor>;

export type FixedKernelBindingKey =
  (typeof fixedKernelBindingDescriptors)[number]["key"];

/**
 * Builds the complete binding plan for one execution.
 *
 * Runtime global/provider names come from the host-provided payload. Fixed
 * kernel names come from the shared kernel. The platform loader uses this plan
 * for lexical destructuring; the kernel uses the same plan to materialize the
 * bindings object passed to the compiled SandboxProgram.
 */
export const sandboxBindingPlan = (
  globals: Readonly<Record<string, unknown>>,
  providers: ReadonlyArray<SandboxBindingProviderManifest>,
): ReadonlyArray<SandboxBindingDescriptor> => [
  ...Object.keys(globals).map((key) => ({ key, source: "global" as const })),
  ...providers.map((provider) => ({
    key: provider.name,
    source: "provider" as const,
  })),
  ...fixedKernelBindingDescriptors,
];

/** Returns every lexical name a platform loader must expose. */
export const injectableBindingKeys = (
  globals: Readonly<Record<string, unknown>>,
  providers: ReadonlyArray<SandboxBindingProviderManifest>,
): ReadonlyArray<string> =>
  sandboxBindingPlan(globals, providers).map((binding) => binding.key);

export const assertInjectableBindingKeys = (options: {
  readonly actual: ReadonlyArray<string>;
  readonly expected: ReadonlyArray<string>;
}): void => {
  if (sameStringArray(options.actual, options.expected)) return;

  throw new Error(
    `Sandbox loader binding keys do not match kernel binding plan: expected ${formatKeys(
      options.expected,
    )}, received ${formatKeys(options.actual)}`,
  );
};

/**
 * Materializes runtime values from a binding plan.
 *
 * This fail-fast helper is deliberately plan-driven. It prevents the kernel
 * from manually spreading a bindings object that can drift from the loader's
 * destructured names.
 */
export const materializeSandboxBindings = (
  plan: ReadonlyArray<SandboxBindingDescriptor>,
  sources: {
    readonly globals: Readonly<Record<string, unknown>>;
    readonly providerBindings: Readonly<Record<string, unknown>>;
    readonly kernelBindings: Readonly<Record<string, unknown>>;
  },
): Readonly<Record<string, unknown>> => {
  const bindings: Record<string, unknown> = {};

  for (const descriptor of plan) {
    switch (descriptor.source) {
      case "global": {
        if (!hasOwn(sources.globals, descriptor.key)) {
          throw new Error(`Missing global binding: ${descriptor.key}`);
        }
        bindings[descriptor.key] = sources.globals[descriptor.key];
        break;
      }
      case "provider": {
        bindings[descriptor.key] = requiredBindingValue(
          sources.providerBindings,
          descriptor.key,
          "provider",
        );
        break;
      }
      case "kernel": {
        bindings[descriptor.key] = requiredBindingValue(
          sources.kernelBindings,
          descriptor.key,
          "kernel",
        );
        break;
      }
    }
  }

  return bindings;
};

const requiredBindingValue = (
  bindings: Readonly<Record<string, unknown>>,
  key: string,
  source: Exclude<SandboxBindingSource, "global">,
): unknown => {
  if (!hasOwn(bindings, key)) {
    throw new Error(`Missing ${source} binding: ${key}`);
  }
  const value = bindings[key];
  if (value === undefined) {
    throw new Error(`Undefined ${source} binding: ${key}`);
  }
  return value;
};

const sameStringArray = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const formatKeys = (keys: ReadonlyArray<string>): string =>
  `[${keys.map((key) => JSON.stringify(key)).join(", ")}]`;

const hasOwn = (
  value: Readonly<Record<string, unknown>>,
  key: string,
): boolean => Object.prototype.hasOwnProperty.call(value, key);
