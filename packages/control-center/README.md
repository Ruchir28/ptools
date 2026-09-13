# @ptools/control-center

Shared React routes and presentation for user-facing ptools browser operations.

The initial section is the Host Auth Center. This package owns React Router
routes, status rendering, interaction, the schema-decoding browser Host API
client, and the normalized browser-authentication integration contract. It does
not own a platform's credential, session API, or login mechanism.

```txt
@ptools/control-center shared React code
  + platform useAuthentication hook
  + platform LoginPage component
  + platform frontend entrypoint and bundler
  -> platform-specific Control Center browser artifact
```

The final executable integration happens at build time. React hooks and
components are code and cannot be passed later as JSON configuration to one
opaque prebuilt bundle. Node, Cloudflare, and future platforms build thin
frontend entrypoints around the same shared `ControlCenterApp`; they do not fork
its routes or presentation. A platform entrypoint imports
`@ptools/control-center/styles.css`, wraps the app in `BrowserRouter`, and passes
its required `ControlCenterBrowserAuthentication` implementation.

The frontend authentication guard is a user-experience boundary only. Platforms
must still verify every protected browser API request and provide a verified
Principal to `@ptools/host-api` middleware. Rendering an authenticated page does
not grant backend authority.

Platforms also own login APIs, cookies or external identity redirects, response
security/cache headers, static-asset mounting, and SPA fallback routing. The
Control Center deliberately does not standardize those mechanisms.
