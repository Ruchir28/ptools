export const publishablePackages = [
  {
    name: "@ptools/core",
    dir: "packages/core",
    internalDeps: [],
  },
  {
    name: "@ptools/executor",
    dir: "packages/executor",
    internalDeps: ["@ptools/core"],
  },
  {
    name: "@ptools/mcp-registry",
    dir: "packages/mcp-registry",
    internalDeps: ["@ptools/core"],
  },
  {
    name: "@ptools/code-mode",
    dir: "packages/code-mode",
    internalDeps: [
      "@ptools/core",
      "@ptools/executor",
      "@ptools/mcp-registry",
    ],
  },
  {
    name: "@ptools/agent-tools",
    dir: "packages/agent-tools",
    internalDeps: [
      "@ptools/code-mode",
      "@ptools/core",
      "@ptools/executor",
      "@ptools/mcp-registry",
    ],
  },
  {
    name: "@ptools/mcp-server",
    dir: "packages/mcp-server",
    internalDeps: [
      "@ptools/code-mode",
      "@ptools/core",
      "@ptools/executor",
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
