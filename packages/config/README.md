# @ptools/config

Host-neutral ptools config parsing, validation, resolution, and stable hashing.

- `@ptools/config` keeps the compatibility surface: config DTO schemas, parsing/resolution helpers, typed errors, and Effect service tags.
- `@ptools/config/contracts` exposes only reusable config DTO/domain schemas.
- `@ptools/config/effect` exposes Effect `Context.Tag` services for config loading and secret resolution.

Source organization:

- `src/contracts/` owns reusable config schemas, domain values, and setup DTOs such as `PtoolsSecretValues`.
- `src/services/` owns Effect service tags.
- `src/config.ts` owns parsing, normalization, secret resolution, and hashing behavior.
