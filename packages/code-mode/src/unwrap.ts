type RecordLike = Readonly<Record<string, unknown>>;

/**
 * Converts an MCP `CallToolResult`-like value into the sandbox-visible value.
 *
 * @param result Raw value returned by `McpRegistry.callTool`.
 * @returns Structured content, parsed/plain text, raw rich content result, or
 * compat `toolResult` depending on the MCP payload shape.
 */
export const unwrapMcpToolResult = (result: unknown): unknown => {
  if (!isRecord(result)) {
    return result;
  }

  if (hasOwn(result, "toolResult")) {
    return result.toolResult;
  }

  if (result.isError === true) {
    throw new Error(extractErrorText(result) ?? "MCP tool returned an error");
  }

  if (
    hasOwn(result, "structuredContent") &&
    result.structuredContent !== undefined
  ) {
    return result.structuredContent;
  }

  if (Array.isArray(result.content) && result.content.every(isTextContent)) {
    const text = result.content.map((item) => item.text).join("\n");

    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  return result;
};

/**
 * Extracts text content from an MCP error result.
 *
 * @param result MCP result object with possible `content` blocks.
 * @returns Joined non-empty text content, when available.
 */
const extractErrorText = (result: RecordLike): string | undefined => {
  if (!Array.isArray(result.content)) {
    return undefined;
  }

  const text = result.content
    .filter(isTextContent)
    .map((item) => item.text)
    .join("\n")
    .trim();

  return text.length === 0 ? undefined : text;
};

/**
 * Checks whether an unknown content block is MCP text content.
 *
 * @param value Unknown content block.
 * @returns `true` when the block has `{ type: "text", text: string }`.
 */
const isTextContent = (
  value: unknown,
): value is { readonly type: "text"; readonly text: string } =>
  isRecord(value) && value.type === "text" && typeof value.text === "string";

/**
 * Checks whether a value can be safely inspected as a plain record.
 *
 * @param value Unknown value.
 * @returns `true` for non-null, non-array objects.
 */
const isRecord = (value: unknown): value is RecordLike =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Checks own-property presence without trusting object prototypes.
 *
 * @param value Record to inspect.
 * @param key Property name to check.
 * @returns Whether the key exists directly on the object.
 */
const hasOwn = (value: RecordLike, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);
