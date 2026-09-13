import type { ComponentType } from "react";

/**
 * Platform authentication state consumed by the shared Control Center guard.
 *
 * Platforms derive this state from their own session API, cookie-backed probe,
 * or external identity mechanism. It contains no credential or permission data:
 * server-side Host API middleware remains the authority for every operation.
 */
export type BrowserAuthenticationState =
  | { readonly _tag: "Checking" }
  | { readonly _tag: "Authenticated" }
  | { readonly _tag: "Unauthenticated" };

/** Values supplied by the shared login route to a platform login page. */
export interface PlatformLoginPageProps {
  /** Validated internal Control Center location requested before login. */
  readonly returnTo: string;

  /** Continue to `returnTo` after an in-page platform login succeeds. */
  readonly onAuthenticated: () => void;
}

/**
 * Executable browser-authentication integration supplied by a platform build.
 *
 * Node, Cloudflare, and future platforms implement the hook against their own
 * APIs and provide their own login component. The shared Control Center calls
 * only this normalized contract and therefore never standardizes passwords,
 * identity-provider redirects, cookies, or session payloads.
 *
 * This is build-time code composition, not runtime JSON configuration: the
 * platform frontend entrypoint bundles these functions with the shared React
 * application.
 */
export interface ControlCenterBrowserAuthentication {
  readonly useAuthentication: () => BrowserAuthenticationState;
  readonly LoginPage: ComponentType<PlatformLoginPageProps>;
}
