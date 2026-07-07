import { z } from "zod";

// JSON Schema subset accepted across the plugin-to-plugin boundary (see
// "Pure-data boundary" in the Tool-publishing API design). Anything outside
// the subset degrades to z.unknown() — an exotic publisher schema must not
// break registration; it just loses server-side validation for that field.
// Contract: must not throw for any input — malformed/cyclic schemas degrade
// gracefully rather than breaking connection building.
export interface JsonSchemaProperty {
  type?: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description?: string;
  enum?: unknown[];
  items?: JsonSchemaProperty;
}

export interface JsonSchemaObject {
  type: "object";
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

const MAX_DEPTH = 16;

function propToZod(p: unknown, depth = 0): z.ZodTypeAny {
  // Null / non-object values (e.g. a properties entry that is literally null) degrade to unknown.
  if (!p || typeof p !== "object") return z.unknown();
  // Depth cap prevents infinite recursion on cyclic schemas (e.g. items: self).
  if (depth > MAX_DEPTH) return z.unknown();

  const prop = p as JsonSchemaProperty;
  let t: z.ZodTypeAny;

  if (prop.enum && Array.isArray(prop.enum) && prop.enum.length > 0) {
    // Only produce a typed enum when every entry is a string; non-string enum
    // values (e.g. numbers) fall back to z.unknown() rather than a cast error.
    if (prop.enum.every((e) => typeof e === "string")) {
      t = z.enum(prop.enum as [string, ...string[]]);
    } else {
      t = z.unknown();
    }
  } else {
    switch (prop.type) {
      case "string":  t = z.string(); break;
      case "number":  t = z.number(); break;
      case "integer": t = z.number().int(); break;
      case "boolean": t = z.boolean(); break;
      case "array":   t = z.array(prop.items ? propToZod(prop.items, depth + 1) : z.unknown()); break;
      default:        t = z.unknown();
    }
  }

  return prop.description && typeof prop.description === "string"
    ? t.describe(prop.description)
    : t;
}

export function jsonSchemaToZodShape(
  schema: JsonSchemaObject | undefined
): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  if (!schema?.properties) return shape;
  const required = new Set(schema.required ?? []);
  for (const [key, prop] of Object.entries(schema.properties)) {
    const t = propToZod(prop);
    shape[key] = required.has(key) ? t : t.optional();
  }
  return shape;
}
