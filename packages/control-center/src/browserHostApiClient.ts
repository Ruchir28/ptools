/** Strict same-origin JSON client used by the React Control Center. */
import type { McpAuthStatus } from "@ptools/auth/contracts";
import {
  HostMcpAuthStatusResponse,
  StartHostMcpAuthResponse,
} from "@ptools/host-api/contracts";
import { Schema } from "effect";

/** Safe browser-API failure consumed by Control Center presentation. */
export class ControlCenterApiError extends Error {
  readonly _tag = "ControlCenterApiError";

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Browser operations needed by the initial Auth Center section. */
export interface BrowserHostApiClient {
  readonly getMcpAuthStatus: (hostId: string) => Promise<McpAuthStatus>;
  readonly startMcpAuth: (
    hostId: string,
    serverName: string,
    force: boolean,
  ) => Promise<URL>;
}

/**
 * Construct a same-origin browser API client around an injectable Fetch
 * implementation. Responses are decoded as unknown through the package-owned
 * schemas before React can render or navigate from them.
 */
export const makeBrowserHostApiClient = (
  fetchImplementation: typeof fetch = globalThis.fetch,
): BrowserHostApiClient => ({
  getMcpAuthStatus: async (hostId) => {
    const response = await fetchImplementation(
      `/api/browser/hosts/${encodeURIComponent(hostId)}/mcp-auth`,
      {
        method: "GET",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      },
    );
    await requireSuccess(response);
    const decoded = await Schema.decodeUnknownPromise(
      HostMcpAuthStatusResponse,
    )(await response.json());
    if (!decoded.result.ok) {
      throw new ControlCenterApiError(
        400,
        "MCP authentication status is unavailable.",
      );
    }
    return decoded.result.status;
  },

  startMcpAuth: async (hostId, serverName, force) => {
    const response = await fetchImplementation(
      `/api/browser/hosts/${encodeURIComponent(hostId)}/mcp-auth/${encodeURIComponent(serverName)}/start`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ force }),
      },
    );
    await requireSuccess(response);
    const decoded = await Schema.decodeUnknownPromise(StartHostMcpAuthResponse)(
      await response.json(),
    );
    if (!decoded.result.ok) {
      throw new ControlCenterApiError(
        400,
        "The MCP authentication flow could not be started.",
      );
    }
    return decodeAuthorizeUrl(decoded.result.authorizeUrl);
  },
});

const requireSuccess = async (response: Response): Promise<void> => {
  if (!response.ok) {
    throw new ControlCenterApiError(
      response.status,
      response.status === 401
        ? "Browser authentication is required."
        : "The Host browser API request failed.",
    );
  }
};

const decodeAuthorizeUrl = (value: string): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ControlCenterApiError(
      500,
      "The Host returned an invalid authorization URL.",
    );
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new ControlCenterApiError(
      500,
      "The Host returned an invalid authorization URL.",
    );
  }
  return url;
};
