import {
  AuthCoordinator,
  McpOAuthCredentialStore,
  McpOAuthStateStore,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("@ptools/auth contracts", () => {
  it("exports runtime service tags for auth capabilities", () => {
    expect(AuthCoordinator).toBeDefined();
    expect(McpOAuthCredentialStore).toBeDefined();
    expect(McpOAuthStateStore).toBeDefined();
  });
});
