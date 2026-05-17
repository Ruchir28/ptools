import { Effect } from "effect";
import { compile, type Options } from "json-schema-to-typescript";
import { CodeModeInvariantError } from "./errors.js";
import type { CodeModeServerMetadata, CodeModeToolMetadata } from "./types.js";

const COMPILE_OPTIONS = {
  bannerComment: "",
  unknownAny: true,
  additionalProperties: true,
  style: {
    semi: true,
    singleQuote: false,
  },
} satisfies Partial<Options>;

interface ToolTypeNames {
  readonly input: string;
  readonly output: string;
}

interface CompiledToolTypes {
  readonly inputType: string;
  readonly outputType: string;
  readonly declarations: ReadonlyArray<string>;
}

export type SchemaCompiler = (
  schema: Parameters<typeof compile>[0],
  typeName: string,
  options: Partial<Options>,
) => Promise<string>;

export interface CachedToolDeclaration {
  readonly toolKey: string;
  readonly inputType: string;
  readonly outputType: string;
  readonly typeDeclarations: ReadonlyArray<string>;
  readonly functionSignature: string;
}

export interface DeclarationIndex {
  readonly tools: ReadonlyMap<string, CachedToolDeclaration>;
}

/**
 * Builds the declaration cache for the model-facing sandbox API.
 *
 * @param servers Grouped Code Mode server metadata.
 * @param schemaCompiler Async JSON Schema compiler. Defaults to
 * `json-schema-to-typescript`.
 * @returns Cached per-tool declaration fragments used by search rendering.
 */
export const buildDeclarationIndex = (
  servers: ReadonlyArray<CodeModeServerMetadata>,
  schemaCompiler: SchemaCompiler = compile,
): Effect.Effect<DeclarationIndex, CodeModeInvariantError> =>
  Effect.gen(function* () {
    const typeNames = yield* Effect.try({
      try: () => reserveTypeNames(servers),
      catch: normalizeInvariantError,
    });
    const tools = new Map<string, CachedToolDeclaration>();

    for (const server of servers) {
      for (const tool of server.tools) {
        const names = getToolTypeNames(typeNames, server, tool);
        const compiled = yield* compileToolTypes(tool, names, schemaCompiler);
        const toolKey = getToolKey(server, tool);

        tools.set(toolKey, {
          toolKey,
          inputType: compiled.inputType,
          outputType: compiled.outputType,
          typeDeclarations: compiled.declarations,
          functionSignature: formatToolSignature(server, tool, compiled),
        });
      }
    }

    return { tools };
  });

/**
 * Renders TypeScript declarations for a selected API surface from cache.
 *
 * @param servers Grouped server metadata, usually already filtered by search.
 * @param declarationIndex Startup-built declaration fragment cache.
 * @returns A declaration string containing cached schema types followed by
 * provider namespaces and function signatures.
 */
export const renderDeclarations = (
  servers: ReadonlyArray<CodeModeServerMetadata>,
  declarationIndex: DeclarationIndex,
): string => {
  const declarationBlocks: Array<string> = [];
  const namespaceBlocks: Array<string> = [];

  for (const server of servers) {
    const signatures: Array<string> = [];

    for (const tool of server.tools) {
      const cached = getCachedToolDeclaration(server, tool, declarationIndex);

      declarationBlocks.push(...cached.typeDeclarations);
      signatures.push(cached.functionSignature);
    }

    namespaceBlocks.push(formatNamespace(server.jsServerName, signatures));
  }

  const declarations = [...declarationBlocks, ...namespaceBlocks]
    .filter((block) => block.trim().length > 0)
    .join("\n\n");

  return declarations.length === 0 ? "" : `${declarations}\n`;
};

/**
 * Generates TypeScript declarations for the model-facing sandbox API.
 *
 * @param servers Grouped Code Mode server metadata.
 * @param schemaCompiler Async JSON Schema compiler. Defaults to
 * `json-schema-to-typescript`.
 * @returns A declaration string rendered from a newly built declaration index.
 */
export const generateDeclarations = (
  servers: ReadonlyArray<CodeModeServerMetadata>,
  schemaCompiler?: SchemaCompiler,
): Effect.Effect<string, CodeModeInvariantError> =>
  buildDeclarationIndex(servers, schemaCompiler).pipe(
    Effect.flatMap((declarationIndex) =>
      Effect.try({
        try: () => renderDeclarations(servers, declarationIndex),
        catch: normalizeInvariantError,
      }),
    ),
  );

/**
 * Finds cached declaration fragments for a tool.
 *
 * @param server Server metadata owning the tool.
 * @param tool Tool metadata to render.
 * @param declarationIndex Startup-built declaration fragment cache.
 * @returns Cached type blocks and function signature for the tool.
 */
const getCachedToolDeclaration = (
  server: CodeModeServerMetadata,
  tool: CodeModeToolMetadata,
  declarationIndex: DeclarationIndex,
): CachedToolDeclaration => {
  const toolKey = getToolKey(server, tool);
  const cached = declarationIndex.tools.get(toolKey);

  if (cached === undefined) {
    throw new CodeModeInvariantError({
      message: `Missing cached declaration for ${toolKey}`,
    });
  }

  return cached;
};

/**
 * Reserves deterministic input/output type names for every tool.
 *
 * @param servers Grouped server metadata.
 * @returns Map from `server.tool` key to generated input/output type names.
 */
const reserveTypeNames = (
  servers: ReadonlyArray<CodeModeServerMetadata>,
): ReadonlyMap<string, ToolTypeNames> => {
  const typeNames = new Map<string, ToolTypeNames>();
  const reserved = new Map<string, string>();

  for (const server of servers) {
    for (const tool of server.tools) {
      const input = makeTypeName(server.jsServerName, tool.jsToolName, "Input");
      const output = makeTypeName(
        server.jsServerName,
        tool.jsToolName,
        "Output",
      );
      const key = getToolKey(server, tool);

      reserveTypeName(reserved, input, key);
      reserveTypeName(reserved, output, key);
      typeNames.set(key, { input, output });
    }
  }

  return typeNames;
};

/**
 * Records a generated type name and fails if another tool already owns it.
 *
 * @param reserved Mutable map of generated type name to owning tool key.
 * @param typeName Type name being reserved.
 * @param owner Tool key that owns the type name.
 */
const reserveTypeName = (
  reserved: Map<string, string>,
  typeName: string,
  owner: string,
): void => {
  const existing = reserved.get(typeName);

  if (existing !== undefined && existing !== owner) {
    throw new CodeModeInvariantError({
      message: `Duplicate generated type name: ${typeName}`,
      cause: { owners: [existing, owner] },
    });
  }

  reserved.set(typeName, owner);
};

/**
 * Looks up pre-reserved type names for a tool.
 *
 * @param typeNames Reserved type-name map.
 * @param server Server metadata owning the tool.
 * @param tool Tool metadata.
 * @returns Generated input/output type names.
 */
const getToolTypeNames = (
  typeNames: ReadonlyMap<string, ToolTypeNames>,
  server: CodeModeServerMetadata,
  tool: CodeModeToolMetadata,
): ToolTypeNames => {
  const key = getToolKey(server, tool);
  const names = typeNames.get(key);

  if (names === undefined) {
    throw new CodeModeInvariantError({
      message: `Missing generated type names for ${key}`,
    });
  }

  return names;
};

/**
 * Compiles one tool's input and output schemas into TypeScript type references.
 *
 * @param tool Tool metadata containing MCP input/output schemas.
 * @param names Reserved input/output type names for the tool.
 * @returns Type names for the function signature plus any generated type blocks.
 */
const compileToolTypes = (
  tool: CodeModeToolMetadata,
  names: ToolTypeNames,
  schemaCompiler: SchemaCompiler,
): Effect.Effect<CompiledToolTypes> =>
  Effect.gen(function* () {
    const input = yield* compileSchemaType(
      tool.inputSchema,
      names.input,
      schemaCompiler,
    );
    const output =
      tool.outputSchema === undefined || tool.outputSchemaInvalid === true
        ? { typeName: "unknown", declaration: undefined }
        : yield* compileSchemaType(
            tool.outputSchema,
            names.output,
            schemaCompiler,
          );

    return {
      inputType: input.typeName,
      outputType: output.typeName,
      declarations: [input.declaration, output.declaration].filter(
        (declaration): declaration is string => declaration !== undefined,
      ),
    };
  });

/**
 * Compiles one JSON Schema value into a named TypeScript declaration.
 *
 * @param schema MCP schema value, kept as `unknown` until basic shape checks pass.
 * @param typeName TypeScript name to give the compiled schema.
 * @returns Generated type declaration and the type name, or `unknown` when the
 * schema is absent, malformed, or rejected by the compiler.
 */
const compileSchemaType = (
  schema: unknown,
  typeName: string,
  schemaCompiler: SchemaCompiler,
): Effect.Effect<{
  readonly typeName: string;
  readonly declaration?: string;
}> => {
  if (!isJsonSchemaObject(schema)) {
    return Effect.succeed({ typeName: "unknown" });
  }

  return Effect.tryPromise({
    try: async () =>
      stripTopLevelExports(
        await schemaCompiler(schema, typeName, COMPILE_OPTIONS),
      ),
    catch: () => undefined,
  }).pipe(
    Effect.match({
      onFailure: () => ({ typeName: "unknown" }),
      onSuccess: (declaration) => ({
        typeName,
        declaration: declaration.trim(),
      }),
    }),
  );
};

/**
 * Checks whether a value is an object-shaped JSON Schema candidate.
 *
 * @param value Unknown MCP schema value.
 * @returns `true` for non-null, non-array objects accepted by the schema compiler.
 */
const isJsonSchemaObject = (
  value: unknown,
): value is Parameters<typeof compile>[0] =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Removes only top-level `export` keywords from generated declarations.
 *
 * @param source Raw output from `json-schema-to-typescript`.
 * @returns Declaration source safe to embed inside a larger `.d.ts` block.
 */
const stripTopLevelExports = (source: string): string =>
  source.replace(/^export\s+(?=(?:interface|type|enum|const\s+enum)\b)/gm, "");

/**
 * Formats one provider namespace and its function signatures.
 *
 * @param jsServerName Sanitized JS namespace name.
 * @param signatures Function signatures for tools in that namespace.
 * @returns `declare namespace` block.
 */
const formatNamespace = (
  jsServerName: string,
  signatures: ReadonlyArray<string>,
): string => {
  const body = signatures
    .map((signature) =>
      signature
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
    )
    .join("\n\n");

  return `declare namespace ${jsServerName} {\n${body}\n}`;
};

/**
 * Formats the TypeScript signature for one sandbox-visible tool function.
 *
 * @param server Server metadata owning the tool.
 * @param tool Tool metadata.
 * @param compiled Compiled input/output type references.
 * @returns JSDoc plus a `function name(input): Promise<output>` signature.
 */
const formatToolSignature = (
  server: CodeModeServerMetadata,
  tool: CodeModeToolMetadata,
  compiled: CompiledToolTypes,
): string => {
  const docs = formatToolDocs(server, tool);
  const signature = `function ${tool.jsToolName}(input: ${compiled.inputType}): Promise<${compiled.outputType}>;`;

  return docs.length === 0 ? signature : `${docs}\n${signature}`;
};

/**
 * Formats JSDoc for one generated tool signature.
 *
 * @param server Server metadata, used to mention original server names.
 * @param tool Tool metadata, used for title/description/original tool name.
 * @returns JSDoc text, or an empty string when no docs are available.
 */
const formatToolDocs = (
  server: CodeModeServerMetadata,
  tool: CodeModeToolMetadata,
): string => {
  const lines: Array<string> = [];

  if (tool.title !== undefined) {
    lines.push(tool.title);
  }

  if (tool.description !== undefined && tool.description !== tool.title) {
    lines.push(tool.description);
  }

  if (server.serverName !== server.jsServerName) {
    lines.push(`Original server: ${server.serverName}`);
  }

  if (tool.originalToolName !== tool.jsToolName) {
    lines.push(`Original tool: ${tool.originalToolName}`);
  }

  if (lines.length === 0) {
    return "";
  }

  return [
    "/**",
    ...lines.flatMap((line, index) => [
      ...(index === 0 ? [] : [" *"]),
      ...line.split("\n").map((part) => ` * ${escapeJsDoc(part)}`),
    ]),
    " */",
  ].join("\n");
};

/**
 * Escapes the only sequence that can prematurely close a JSDoc block.
 *
 * @param value Raw documentation text from MCP metadata.
 * @returns JSDoc-safe text.
 */
const escapeJsDoc = (value: string): string => value.replace(/\*\//g, "* /");

/**
 * Builds the deterministic type name for a tool schema.
 *
 * @param jsServerName Sanitized server namespace.
 * @param jsToolName Sanitized tool function name.
 * @param suffix Whether the type is for input or output.
 * @returns PascalCase type name.
 */
const makeTypeName = (
  jsServerName: string,
  jsToolName: string,
  suffix: "Input" | "Output",
): string =>
  `${toPascalCase(jsServerName)}${toPascalCase(jsToolName)}${suffix}`;

/**
 * Converts a JS identifier-like string into PascalCase for type names.
 *
 * @param value Sanitized JS server or tool name.
 * @returns PascalCase string, prefixed when needed to start with a letter.
 */
const toPascalCase = (value: string): string => {
  const words = value.match(/[A-Za-z0-9]+/g) ?? [];
  const pascal = words.map(capitalize).join("");

  if (pascal.length === 0) {
    return "Value";
  }

  return /^[A-Za-z]/.test(pascal) ? pascal : `T${pascal}`;
};

/**
 * Uppercases the first character of a word.
 *
 * @param value Word segment.
 * @returns Capitalized word segment.
 */
const capitalize = (value: string): string =>
  value.length === 0
    ? value
    : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;

/**
 * Creates a stable lookup key for a tool.
 *
 * @param server Server metadata.
 * @param tool Tool metadata.
 * @returns `jsServerName.jsToolName` key.
 */
const getToolKey = (
  server: CodeModeServerMetadata,
  tool: CodeModeToolMetadata,
): string => `${server.jsServerName}.${tool.jsToolName}`;

/**
 * Converts thrown declaration-generation failures into the package error type.
 *
 * @param cause Unknown thrown value during declaration generation.
 * @returns Code Mode invariant error.
 */
const normalizeInvariantError = (cause: unknown): CodeModeInvariantError =>
  cause instanceof CodeModeInvariantError
    ? cause
    : new CodeModeInvariantError({
        message: "Failed to generate Code Mode declarations",
        cause,
      });
