/** Presentation query decoding for the Control Center Auth Center route. */

/** Auth Center presentation intent carried by a human-navigation URL. */
export type AuthCenterIntent = "authorize" | "reauthorize" | "setup";

/** Provider card and explanation selected by an Auth Center browser URL. */
export interface AuthCenterSelection {
  readonly serverName: string;
  readonly intent: AuthCenterIntent;
}

/**
 * Presentation state decoded from the Auth Center query string.
 *
 * React Router owns path matching and Host ID decoding. This helper only parses
 * optional UI selection; its values never cross the Host API boundary or grant
 * authority.
 */
export interface AuthCenterQuery {
  readonly selection?: AuthCenterSelection | undefined;
  readonly error?: string | undefined;
}

/** Decode optional Auth Center selection from React Router search parameters. */
export const parseAuthCenterQuery = (
  searchParams: URLSearchParams,
): AuthCenterQuery => {
  const serverName = searchParams.get("server");
  const intent = searchParams.get("intent");
  if (serverName === null && intent === null) {
    return {};
  }
  if (
    serverName === null ||
    serverName.length === 0 ||
    !isAuthCenterIntent(intent)
  ) {
    return { error: "The selected server link is malformed." };
  }
  return { selection: { serverName, intent } };
};

const isAuthCenterIntent = (value: string | null): value is AuthCenterIntent =>
  value === "authorize" || value === "reauthorize" || value === "setup";
