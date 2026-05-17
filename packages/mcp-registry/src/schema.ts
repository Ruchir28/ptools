import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type {
  JsonSchemaType,
  JsonSchemaValidator,
  jsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation";

/**
 * SDK validator used by the MCP client for upstream tool output schemas.
 *
 * Good schemas still get the normal AJV-backed validator. Broken schemas get a
 * pass-through validator so discovery can finish and the registry can attach a
 * named diagnostic to the offending tool afterwards. The same compiled
 * validator is also what the SDK uses for `callTool()` structured-content
 * validation, so tools with broken output schemas cannot be runtime-validated
 * unless their upstream schema is fixed.
 */
export class TolerantOutputSchemaValidator implements jsonSchemaValidator {
  private readonly delegate = new AjvJsonSchemaValidator();

  /**
   * Creates a validator for an advertised output schema.
   *
   * @param schema JSON Schema from the upstream MCP tool metadata.
   * @returns AJV validator when compilation succeeds, otherwise a pass-through
   * validator for this one broken schema.
   */
  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    try {
      return this.delegate.getValidator<T>(schema);
    } catch {
      return (input: unknown) => ({
        valid: true,
        data: input as T,
        errorMessage: undefined,
      });
    }
  }
}

const validator = new AjvJsonSchemaValidator();

/**
 * Checks whether a registry-critical input schema can be compiled by the MCP
 * SDK's normal AJV validator.
 *
 * @param schema Upstream MCP schema value.
 * @returns A human-readable error when the schema is invalid, otherwise
 * `undefined`.
 */
export const validateInputSchema = (schema: unknown): string | undefined =>
  validateSchema(schema);

/**
 * Checks whether an optional output schema can be compiled by the MCP SDK's
 * normal AJV validator.
 *
 * @param schema Upstream MCP output schema value.
 * @returns A human-readable error when the schema is invalid, otherwise
 * `undefined`.
 */
export const validateOutputSchema = (schema: unknown): string | undefined =>
  validateSchema(schema);

/**
 * Compiles one JSON Schema candidate without validating any runtime value.
 *
 * @param schema Unknown schema value received from MCP discovery.
 * @returns An error message for malformed or non-compilable schemas.
 */
const validateSchema = (schema: unknown): string | undefined => {
  if (!isJsonSchemaObject(schema)) {
    return "Schema must be a JSON object";
  }

  try {
    validator.getValidator(schema);
    return undefined;
  } catch (cause) {
    return safeErrorMessage(cause);
  }
};

/**
 * Narrows unknown MCP metadata to the object-shaped JSON Schema form expected
 * by the SDK validator.
 *
 * @param value Unknown schema candidate.
 * @returns `true` when the value is a non-null object and not an array.
 */
const isJsonSchemaObject = (value: unknown): value is JsonSchemaType =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Converts arbitrary thrown values into a stable diagnostic message.
 *
 * @param cause Unknown thrown value.
 * @returns Safe, human-readable message.
 */
export const safeErrorMessage = (cause: unknown): string => {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }

  return String(cause);
};
