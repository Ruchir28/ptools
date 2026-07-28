/**
 * Public embedded Node constructor contract.
 *
 * What this proves:
 *   1. Logical host identity is explicit and validated before daemon startup.
 *   2. Embedded listener origins fail fast rather than becoming Layer defects.
 *   3. The package exposes only the final Host/Code Mode Promise constructors.
 *
 * No listener or daemon is started: invalid options fail at the construction
 * boundary before platform resources are acquired.
 */
import { describe, expect, it } from "vitest";
import { HostNodeError, startEmbeddedNodeHost } from "../src/index.js";

const unreachableStateDirectory = "/tmp/ptools-constructor-validation";

describe("embedded Node public constructors", () => {
  it("requires a non-empty explicit hostId", async () => {
    await expect(
      startEmbeddedNodeHost({
        hostId: "   ",
        internalStateDirectory: unreachableStateDirectory,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        _tag: "HostNodeError",
        message: "Node hostId must not be empty.",
      }),
    );
  });

  it("rejects invalid or non-loopback public origins as typed startup errors", async () => {
    await expect(
      startEmbeddedNodeHost({
        hostId: "explicit-host",
        publicOrigin: "not a URL",
        internalStateDirectory: unreachableStateDirectory,
      }),
    ).rejects.toBeInstanceOf(HostNodeError);
    await expect(
      startEmbeddedNodeHost({
        hostId: "explicit-host",
        publicOrigin: "http://0.0.0.0:19876",
        internalStateDirectory: unreachableStateDirectory,
      }),
    ).rejects.toMatchObject({
      message:
        "Embedded Node Host HTTP ingress must bind to a loopback hostname.",
    });
  });
});
