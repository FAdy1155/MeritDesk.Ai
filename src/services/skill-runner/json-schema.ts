import { z } from "zod";

/**
 * zod schema -> the JSON Schema object used both as a tool's input_schema
 * (run.ts, tools.ts) and as skill_definitions.output_json_schema (seed).
 * The top-level $schema key is dropped; the Messages API tool input_schema
 * doesn't take it. A discriminated union (e.g. the generate_document spec's
 * block types) comes out of zod as `oneOf`; it is rewritten to `anyOf`, the
 * union keyword the Claude API documents for tool schemas. The branches are
 * mutually exclusive by their discriminator, so the meaning is unchanged.
 */
export function toJsonSchemaObject(schema: z.ZodType): Record<string, unknown> {
  const json = oneOfToAnyOf(z.toJSONSchema(schema)) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

function oneOfToAnyOf(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(oneOfToAnyOf);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    // Only the keyword (an array of subschemas), never a property that happens to be named oneOf.
    out[key === "oneOf" && Array.isArray(value) ? "anyOf" : key] = oneOfToAnyOf(value);
  }
  return out;
}
