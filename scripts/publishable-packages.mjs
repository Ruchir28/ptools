export const publishablePackages = [
  {
    name: "@ptools/config",
    dir: "packages/config",
    internalDeps: [],
  },
  {
    name: "@ptools/core",
    dir: "packages/core",
    internalDeps: [],
  },
  {
    name: "@ptools/auth",
    dir: "packages/auth",
    internalDeps: ["@ptools/config"],
  },
  {
    name: "@ptools/host-context",
    dir: "packages/host-context",
    internalDeps: [],
  },
  {
    name: "@ptools/host-api",
    dir: "packages/host-api",
    internalDeps: [
      "@ptools/auth",
      "@ptools/code-mode-api",
      "@ptools/config",
    ],
  },
  {
    name: "@ptools/host-runtime",
    dir: "packages/host-runtime",
    internalDeps: [
      "@ptools/auth",
      "@ptools/code-mode",
      "@ptools/code-mode-api",
      "@ptools/config",
      "@ptools/executor",
      "@ptools/host-api",
      "@ptools/host-context",
      "@ptools/mcp-registry",
    ],
  },
  {
    name: "@ptools/host-node",
    dir: "packages/host-node",
    internalDeps: [
      "@ptools/auth",
      "@ptools/code-mode-api",
      "@ptools/config",
      "@ptools/executor",
      "@ptools/host-api",
      "@ptools/host-context",
      "@ptools/host-runtime",
      "@ptools/mcp-registry",
    ],
  },
  {
    name: "@ptools/executor",
    dir: "packages/executor",
    internalDeps: [],
  },
  {
    name: "@ptools/mcp-registry",
    dir: "packages/mcp-registry",
    internalDeps: [],
  },
  {
    name: "@ptools/code-mode-api",
    dir: "packages/code-mode-api",
    internalDeps: [],
  },
  {
    name: "@ptools/code-mode",
    dir: "packages/code-mode",
    internalDeps: [
      "@ptools/code-mode-api",
      "@ptools/executor",
      "@ptools/mcp-registry",
    ],
  },
  {
    name: "@ptools/agent-tools",
    dir: "packages/agent-tools",
    internalDeps: ["@ptools/code-mode-api"],
  },
  {
    name: "@ptools/mcp-server",
    dir: "packages/mcp-server",
    internalDeps: ["@ptools/code-mode-api"],
  },
  {
    name: "@ptools/cli",
    dir: "packages/cli",
    internalDeps: [
      "@ptools/config",
      "@ptools/host-node",
      "@ptools/mcp-server",
    ],
  },
];

export const distFileGlobs = [
  "dist/*.js",
  "dist/*.js.map",
  "dist/*.d.ts",
  "dist/*.d.ts.map",
];

export const requiredFiles = ["README.md", "LICENSE"];
