/**
 * Promise SDK constructors for the embeddable Node host start path.
 *
 * These are not remote-only clients. Each constructor boots
 * `NodeEmbeddedHostHttpStackLive`, which starts the in-process HTTP ingress
 * (listener + daemon discovery/lease) and returns a client pointed at that
 * local origin. `handle.close()` tears the embedded stack down.
 *
 * For a listener without an owned client, use `NodeHostHttpServerLive` instead.
 */
import type { CodeModeClientHandle } from "@ptools/code-mode-api";
import type { HostClientHandle } from "@ptools/host-api";
import { makeHostHttpClientHandle } from "@ptools/host-api/effect";
import { NodeEmbeddedHostHttpStackLive } from "./http/hostHttp.js";
import { HostNodeError, type NodeHostOptions } from "./options.js";

/**
 * Embeddable start path: boot one local Node host ingress and return the
 * shared Promise `HostClientHandle` for it.
 *
 * Under the hood this owns `NodeEmbeddedHostHttpStackLive` in a ManagedRuntime
 * (via `makeHostHttpClientHandle`) — server + client together, not a connection
 * to an already-running deployment. Closing the returned handle shuts down the
 * owned HTTP ingress.
 */
export const startEmbeddedNodeHost = async (
  options: NodeHostOptions,
): Promise<HostClientHandle> => {
  try {
    return await makeHostHttpClientHandle(
      NodeEmbeddedHostHttpStackLive(options),
    );
  } catch (cause) {
    throw findHostNodeError(cause) ?? cause;
  }
};

/**
 * Same embeddable start path as `startEmbeddedNodeHost`, exposing only the
 * focused Code Mode handle. Closing that handle still shuts down the whole
 * embedded host (shared runtime lifetime).
 */
export const createNodeCodeModeClient = async (
  options: NodeHostOptions,
): Promise<CodeModeClientHandle> =>
  (await startEmbeddedNodeHost(options)).codeMode;

/** Recover the typed startup failure from Effect's Promise rejection wrapper. */
const findHostNodeError = (
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): HostNodeError | undefined => {
  if (value instanceof HostNodeError) return value;
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return undefined;
  }

  seen.add(value);
  for (const key of [
    ...Object.keys(value),
    ...Object.getOwnPropertySymbols(value),
  ]) {
    const nested = findHostNodeError(
      (value as Record<PropertyKey, unknown>)[key],
      seen,
    );
    if (nested !== undefined) return nested;
  }

  return undefined;
};
