import { z } from "zod";

// JSON Schema subset accepted across the plugin-to-plugin boundary (see
// "Pure-data boundary" in the Tool-publishing API design). Anything outside
// the subset degrades to z.unknown() — an exotic publisher schema must not
// break registration; it just loses server-side validation for that field.
export interface JsonSchemaProperty {
  type?: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description?: string;
  enum?: string[];
  items?: JsonSchemaProperty;
}

export interface JsonSchemaObject {
  type: "object";
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

function propToZod(p: JsonSchemaProperty): z.ZodTypeAny {
  let t: z.ZodTypeAny;
  if (p.enum && p.enum.length > 0) t = z.enum(p.enum as [string, ...string[]]);
  else switch (p.type) {
    case "string": t = z.string(); break;
    case "number": t = z.number(); break;
    case "integer": t = z.number().int(); break;
    case "boolean": t = z.boolean(); break;
    case "array": t = z.array(p.items ? propToZod(p.items) : z.unknown()); break;
    default: t = z.unknown();
  }
  return p.description ? t.describe(p.description) : t;
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
