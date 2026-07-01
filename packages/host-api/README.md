# @ptools/host-api

Transport-agnostic host protocol contracts and client shapes.

- `@ptools/host-api` exposes Host operation DTO schemas, validation helpers, codecs, protocol response helpers, and the Promise `HostClientHandle`.
- `@ptools/host-api/contracts` exposes only the reusable host protocol DTO schemas.
- `@ptools/host-api/effect` is the public Effect-native subpath for service tags and shared layers.

Source organization:

- `src/contracts/` owns reusable transport-agnostic DTO schemas.
- `src/services/` owns Effect `Context.Tag` service contracts and shared Effect layers.
- The public `./contracts` export re-exports `src/contracts/index.ts`.
- The public `./effect` export re-exports the services surface for Effect-native SDK users.
