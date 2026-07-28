# @ptools/host-api

Shared Host operation contracts, HTTP routes, and client capabilities.

- `@ptools/host-api` exposes transport-agnostic operation DTOs and the Promise
  `HostClientHandle` shape.
- `@ptools/host-api/contracts` exposes reusable host protocol schemas.
- `@ptools/host-api/http` exposes the shared HTTP API and
  `createHostHttpClient(...)` for ordinary JavaScript/TypeScript callers.
- `@ptools/host-api/effect` exposes Effect services and layers.

## Connect to an existing Host HTTP deployment

```ts
import { createHostHttpClient } from "@ptools/host-api/http";

const host = await createHostHttpClient({
  baseUrl: "https://host.example.com",
  hostId: "main",
  accessToken,
});

try {
  await host.call({ operation: "configure", input: { config } });
  await host.codeMode.call(request);
} finally {
  await host.close();
}
```

This constructor starts no server and owns no actor. `close()` disposes only the
calling process's client runtime.

## Effect-native client

```ts
import {
  HostHttpClient,
  HostHttpClientFetchLive,
} from "@ptools/host-api/effect";

const program = Effect.gen(function* () {
  const host = yield* HostHttpClient;
  return yield* host.configure({ config });
}).pipe(
  Effect.provide(
    HostHttpClientFetchLive({ baseUrl, hostId, accessToken }),
  ),
);
```

`HostHttpClientFetchLive` owns the single validation path. Invalid URLs, empty
host IDs, and empty tokens fail with `HostHttpClientConfigError`; the Promise
constructor wraps that same layer and duplicates no validation.

Source organization:

- `src/contracts/` owns transport-agnostic DTO schemas.
- `src/services/` owns Effect service contracts and shared layers.
- `src/http/` owns the shared HTTP carrier and Promise adapter.
