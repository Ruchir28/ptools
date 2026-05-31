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
    name: "@ptools/host-node",
    dir: "packages/host-node",
    internalDeps: ["@ptools/config"],
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
    name: "@ptools/code-mode",
    dir: "packages/code-mode",
    internalDeps: [
      "@ptools/executor",
      "@ptools/mcp-registry",
    ],
  },
  {
    name: "@ptools/agent-tools",
    dir: "packages/agent-tools",
    internalDeps: [
      "@ptools/code-mode",
      "@ptools/config",
      "@ptools/executor",
      "@ptools/host-node",
      "@ptools/mcp-registry",
    ],
  },
  {
    name: "@ptools/mcp-server",
    dir: "packages/mcp-server",
    internalDeps: [
      "@ptools/code-mode",
      "@ptools/executor",
      "@ptools/host-node",
      "@ptools/mcp-registry",
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
