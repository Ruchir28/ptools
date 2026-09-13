import type {
  McpAuthServerStatus,
  McpAuthStatus,
  McpAuthStatusValue,
} from "@ptools/auth/contracts";
import { useEffect, useState } from "react";
import {
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";
import {
  ControlCenterApiError,
  type BrowserHostApiClient,
  makeBrowserHostApiClient,
} from "./browserHostApiClient.js";
import {
  type AuthCenterSelection,
  parseAuthCenterQuery,
} from "./authCenterQuery.js";
import type { ControlCenterBrowserAuthentication } from "./browserAuthenticationIntegration.js";

/** Build-time platform integration and test seams for the Control Center. */
export interface ControlCenterAppProps {
  /** Platform-owned browser session hook and login page. */
  readonly authentication: ControlCenterBrowserAuthentication;

  /** Shared Host API client; overridden only by focused tests. */
  readonly api?: BrowserHostApiClient | undefined;

  /** External OAuth-provider navigation seam; overridden only by tests. */
  readonly openExternalUrl?: ((url: URL) => void) | undefined;
}

/**
 * Shared React application for user-facing ptools browser operations.
 *
 * React Router owns browser path matching and location updates. The platform
 * supplies executable browser-authentication code when it builds its final
 * frontend, while shared routes consume only normalized authentication state.
 * The platform entrypoint renders this component beneath `BrowserRouter`.
 * Server-side middleware remains authoritative for every Host API operation.
 */
export const ControlCenterApp = ({
  authentication,
  api = defaultBrowserHostApiClient,
  openExternalUrl = redirectBrowserToExternalUrl,
}: ControlCenterAppProps) => (
  <Routes>
    <Route
      path="/login"
      element={
        <PlatformLoginRoute
          LoginPage={authentication.LoginPage}
          useAuthentication={authentication.useAuthentication}
        />
      }
    />
    <Route
      element={
        <RequireBrowserAuthentication
          useAuthentication={authentication.useAuthentication}
        />
      }
    >
      <Route
        path="/hosts/:hostId/auth"
        element={<AuthCenterRoute api={api} openExternalUrl={openExternalUrl} />}
      />
    </Route>
    <Route path="*" element={<ControlCenterNotFound />} />
  </Routes>
);

const RequireBrowserAuthentication = ({
  useAuthentication,
}: {
  readonly useAuthentication: ControlCenterBrowserAuthentication["useAuthentication"];
}) => {
  const authentication = useAuthentication();
  const location = useLocation();

  switch (authentication._tag) {
    case "Checking":
      return <ControlCenterLoading />;
    case "Unauthenticated": {
      const returnTo = `${location.pathname}${location.search}${location.hash}`;
      return (
        <Navigate
          to={`/login?returnTo=${encodeURIComponent(returnTo)}`}
          replace
        />
      );
    }
    case "Authenticated":
      return <Outlet />;
  }
};

const PlatformLoginRoute = ({
  LoginPage,
  useAuthentication,
}: {
  readonly LoginPage: ControlCenterBrowserAuthentication["LoginPage"];
  readonly useAuthentication: ControlCenterBrowserAuthentication["useAuthentication"];
}) => {
  const authentication = useAuthentication();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const returnTo = safeInternalReturnTo(searchParams.get("returnTo"));

  switch (authentication._tag) {
    case "Checking":
      return <ControlCenterLoading />;
    case "Authenticated":
      return <Navigate to={returnTo} replace />;
    case "Unauthenticated":
      return (
        <LoginPage
          returnTo={returnTo}
          onAuthenticated={() => navigate(returnTo, { replace: true })}
        />
      );
  }
};

const ControlCenterLoading = () => (
  <ControlCenterShell>
    <p>Checking browser authentication…</p>
  </ControlCenterShell>
);

const internalReturnBase = new URL("https://control-center.invalid");

/** Prevent a platform login completion from becoming an open redirect. */
const safeInternalReturnTo = (candidate: string | null): string => {
  if (candidate === null || !candidate.startsWith("/")) return "/";

  try {
    const resolved = new URL(candidate, internalReturnBase);
    return resolved.origin === internalReturnBase.origin
      ? `${resolved.pathname}${resolved.search}${resolved.hash}`
      : "/";
  } catch {
    return "/";
  }
};

const AuthCenterRoute = ({
  api,
  openExternalUrl,
}: {
  readonly api: BrowserHostApiClient;
  readonly openExternalUrl: (url: URL) => void;
}) => {
  const { hostId } = useParams<"hostId">();
  const [searchParams] = useSearchParams();
  const query = parseAuthCenterQuery(searchParams);

  if (hostId === undefined || hostId.length === 0) {
    return <ControlCenterNotFound />;
  }

  return (
    <AuthCenterPage
      hostId={hostId}
      selection={query.selection}
      routeError={query.error}
      api={api}
      openExternalUrl={openExternalUrl}
    />
  );
};

const ControlCenterNotFound = () => (
  <ControlCenterShell>
    <h1>Page not found</h1>
    <p>The requested Control Center page does not exist.</p>
  </ControlCenterShell>
);

interface AuthCenterPageProps {
  readonly hostId: string;
  readonly selection?: AuthCenterSelection | undefined;
  readonly routeError?: string | undefined;
  readonly api: BrowserHostApiClient;
  readonly openExternalUrl: (url: URL) => void;
}

const AuthCenterPage = ({
  hostId,
  selection,
  routeError,
  api,
  openExternalUrl,
}: AuthCenterPageProps) => {
  const [status, setStatus] = useState<McpAuthStatus>();
  const [error, setError] = useState<string>();
  const [busyServer, setBusyServer] = useState<string>();

  useEffect(() => {
    let active = true;
    setStatus(undefined);
    setError(undefined);
    api.getMcpAuthStatus(hostId).then(
      (next) => {
        if (active) setStatus(next);
      },
      (cause) => {
        if (active) setError(toSafeUiError(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [api, hostId]);

  const start = async (serverName: string, force: boolean) => {
    setBusyServer(serverName);
    setError(undefined);
    try {
      openExternalUrl(await api.startMcpAuth(hostId, serverName, force));
    } catch (cause) {
      setError(toSafeUiError(cause));
      setBusyServer(undefined);
    }
  };

  return (
    <ControlCenterShell>
      <header>
        <p className="eyebrow">Host</p>
        <h1>Auth Center</h1>
        <p className="host-id">{hostId}</p>
      </header>
      {routeError ? <Notice tone="warning">{routeError}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {!status && !error ? <p>Loading authentication status…</p> : null}
      {status ? (
        <AuthCenterStatusView
          status={status}
          selection={selection}
          busyServer={busyServer}
          onStart={start}
        />
      ) : null}
    </ControlCenterShell>
  );
};

/** Props for the pure authoritative-status view used by tests and the live page. */
export interface AuthCenterStatusViewProps {
  readonly status: McpAuthStatus;
  readonly selection?: AuthCenterSelection | undefined;
  readonly busyServer?: string | undefined;
  readonly onStart: (
    serverName: string,
    force: boolean,
  ) => void | Promise<void>;
}

/**
 * Render all MCP authentication states from the latest browser API response.
 *
 * Query selection only highlights a card. The response status decides whether
 * an action exists and whether it is an initial or forced authorization.
 */
export const AuthCenterStatusView = ({
  status,
  selection,
  busyServer,
  onStart,
}: AuthCenterStatusViewProps) => {
  const selectedExists = selection
    ? status.servers.some(
        (server) => server.serverName === selection.serverName,
      )
    : true;

  return (
    <section aria-label="MCP authentication">
      {selection ? (
        <p>
          {intentLabel(selection.intent)}:{" "}
          <strong>{selection.serverName}</strong>
        </p>
      ) : (
        <p>Select an MCP server to inspect its authentication state.</p>
      )}
      {!selectedExists ? (
        <Notice tone="warning">
          The selected MCP server is not present in the current Host status.
        </Notice>
      ) : null}
      <div className="server-grid">
        {status.servers.length === 0 ? (
          <p>No MCP servers are configured.</p>
        ) : (
          status.servers.map((server) => {
            const action = actionForStatus(server.status);
            return (
              <article
                className={
                  server.serverName === selection?.serverName
                    ? "server-card selected"
                    : "server-card"
                }
                key={server.serverName}
              >
                <h2>{server.serverName}</h2>
                <p className="status">{statusLabel(server.status)}</p>
                {server.message ? <p>{server.message}</p> : null}
                {server.lastError ? (
                  <p className="error">{server.lastError}</p>
                ) : null}
                <StatusGuidance status={server.status} />
                {action ? (
                  <button
                    type="button"
                    disabled={busyServer === server.serverName}
                    onClick={() => onStart(server.serverName, action.force)}
                  >
                    {busyServer === server.serverName
                      ? "Working…"
                      : action.label}
                  </button>
                ) : null}
              </article>
            );
          })
        )}
      </div>
    </section>
  );
};

const StatusGuidance = ({
  status,
}: {
  readonly status: McpAuthStatusValue;
}) => {
  switch (status) {
    case "needs_config":
      return (
        <div>
          <p>
            This server requires manual OAuth client configuration before
            authorization can start.
          </p>
          <ol>
            <li>
              Configure <code>auth.clientId</code>.
            </li>
            <li>
              Configure <code>auth.clientSecret</code> only when required.
            </li>
            <li>Apply the Host configuration, then reload this page.</li>
          </ol>
        </div>
      );
    case "static_credentials":
      return (
        <p>Static credentials are configured; browser OAuth is not needed.</p>
      );
    case "unsupported_auth":
      return <p>This server does not support a browser authentication flow.</p>;
    case "disabled":
      return <p>This MCP server is disabled.</p>;
    case "connected":
    case "requires_auth":
    case "auth_in_progress":
    case "auth_failed":
      return null;
  }
};

const actionForStatus = (
  status: McpAuthStatusValue,
): { readonly label: string; readonly force: boolean } | undefined => {
  switch (status) {
    case "connected":
      return { label: "Reconnect", force: true };
    case "requires_auth":
      return { label: "Connect", force: false };
    case "auth_in_progress":
      return { label: "Continue authorization", force: false };
    case "auth_failed":
      return { label: "Retry authorization", force: true };
    case "needs_config":
    case "static_credentials":
    case "unsupported_auth":
    case "disabled":
      return undefined;
  }
};

const statusLabel = (status: McpAuthServerStatus["status"]): string => {
  switch (status) {
    case "connected":
      return "Connected";
    case "requires_auth":
      return "Authorization required";
    case "auth_in_progress":
      return "Authorization in progress";
    case "auth_failed":
      return "Authorization failed";
    case "needs_config":
      return "OAuth client configuration required";
    case "static_credentials":
      return "Static credentials";
    case "unsupported_auth":
      return "Unsupported authentication";
    case "disabled":
      return "Disabled";
  }
};

const intentLabel = (intent: AuthCenterSelection["intent"]): string => {
  switch (intent) {
    case "authorize":
      return "Connect";
    case "reauthorize":
      return "Reconnect";
    case "setup":
      return "Configure";
  }
};

const Notice = ({
  children,
  tone,
}: {
  readonly children: React.ReactNode;
  readonly tone: "error" | "warning";
}) => (
  <p className={`notice ${tone}`} role="alert">
    {children}
  </p>
);

const ControlCenterShell = ({
  children,
}: {
  readonly children: React.ReactNode;
}) => (
  <div className="shell">
    <nav aria-label="Control Center">
      <strong>ptools Control Center</strong>
    </nav>
    <main>{children}</main>
  </div>
);

const defaultBrowserHostApiClient = makeBrowserHostApiClient();

const redirectBrowserToExternalUrl = (url: URL): void => {
  globalThis.location.assign(url);
};

const toSafeUiError = (cause: unknown): string =>
  cause instanceof ControlCenterApiError
    ? cause.message
    : "The Control Center could not complete the request.";
