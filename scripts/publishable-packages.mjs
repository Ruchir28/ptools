export const publishablePackages = [
  {
    name: "@p_tools/core",
    dir: "packages/core",
    internalDeps: [],
  },
  {
    name: "@p_tools/executor",
    dir: "packages/executor",
    internalDeps: ["@p_tools/core"],
  },
  {
    name: "@p_tools/mcp-registry",
    dir: "packages/mcp-registry",
    internalDeps: ["@p_tools/core"],
  },
  {
    name: "@p_tools/code-mode",
    dir: "packages/code-mode",
    internalDeps: [
      "@p_tools/core",
      "@p_tools/executor",
      "@p_tools/mcp-registry",
    ],
  },
  {
    name: "@p_tools/agent-tools",
    dir: "packages/agent-tools",
    internalDeps: [
      "@p_tools/code-mode",
      "@p_tools/core",
      "@p_tools/executor",
      "@p_tools/mcp-registry",
    ],
  },
  {
    name: "@p_tools/mcp-server",
    dir: "packages/mcp-server",
    internalDeps: [
      "@p_tools/code-mode",
      "@p_tools/core",
      "@p_tools/executor",
      "@p_tools/mcp-registry",
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
