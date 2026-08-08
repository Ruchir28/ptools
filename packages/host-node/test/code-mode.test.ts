/**
 * Public local-deployment constructor contract.
 *
 * What this proves:
 *   Logical host identity is validated before catalog or process startup.
 *
 * No listener or daemon is started.
 */
import { describe, expect, it } from "vitest";
import { connectLocalNodeHost } from "../src/index.js";

describe("local Node public constructor", () => {
  it("requires a non-empty hostId", async () => {
    await expect(connectLocalNodeHost({ hostId: "   " })).rejects.toMatchObject({
      _tag: "NodeLocalDeploymentError",
      message: "Node hostId must not be empty.",
    });
  });
});
