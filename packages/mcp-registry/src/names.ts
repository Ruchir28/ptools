import { Effect } from "effect";
import { NameCollisionError } from "./errors.js";

const RESERVED_WORDS = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

export const sanitizeJsIdentifier = (name: string): string => {
  const trimmed = name.trim();
  const sanitized = trimmed
    .replace(/^[^A-Za-z_$]+/, "_")
    .replace(/[^A-Za-z0-9_$]/g, "_");
  const nonEmpty = sanitized.length > 0 ? sanitized : "_";

  return RESERVED_WORDS.has(nonEmpty) ? `${nonEmpty}_` : nonEmpty;
};

export const buildNameMap = (
  originals: ReadonlyArray<string>,
  scope: string,
): Effect.Effect<ReadonlyMap<string, string>, NameCollisionError> =>
  Effect.gen(function* () {
    const byJsName = new Map<string, Array<string>>();

    for (const original of originals) {
      const jsName = sanitizeJsIdentifier(original);
      const bucket = byJsName.get(jsName) ?? [];
      bucket.push(original);
      byJsName.set(jsName, bucket);
    }

    for (const [jsName, collidingOriginals] of byJsName) {
      if (collidingOriginals.length > 1) {
        return yield* Effect.fail(
          new NameCollisionError({
            scope,
            jsName,
            originals: collidingOriginals,
          }),
        );
      }
    }

    const originalToJsName = new Map<string, string>();

    for (const [jsName, [original]] of byJsName) {
      if (original !== undefined) {
        originalToJsName.set(original, jsName);
      }
    }

    return originalToJsName;
  });

export const getMappedName = (
  map: ReadonlyMap<string, string>,
  original: string,
  scope: string,
): Effect.Effect<string, NameCollisionError> => {
  const mapped = map.get(original);

  return mapped === undefined
    ? Effect.fail(
        new NameCollisionError({
          scope,
          jsName: original,
          originals: [original],
        }),
      )
    : Effect.succeed(mapped);
};
