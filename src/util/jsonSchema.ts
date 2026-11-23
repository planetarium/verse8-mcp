import type { ZodTypeAny } from "zod";

/**
 * Minimal zod → JSON Schema converter tailored to the small schemas used by
 * the Verse8 MCP tools (objects with string, optional string, optional
 * string[]). Avoiding the `zod-to-json-schema` dep keeps the dependency
 * surface tight.
 *
 * Field `.describe()` text is emitted as `description` and `z.enum` values
 * as `enum`: the host LLM sees only this JSON Schema, so a value list or
 * hint that stays in zod is invisible until a call fails validation.
 */
export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, object>;
  required?: string[];
  additionalProperties?: boolean;
  [k: string]: unknown;
}

export function zodToJsonSchema(schema: ZodTypeAny): JsonSchemaObject {
  const def: any = (schema as any)._def;
  const typeName: string = def?.typeName ?? "";

  if (typeName === "ZodObject") {
    const shape = def.shape();
    const properties: Record<string, object> = {};
    const required: string[] = [];
    for (const key of Object.keys(shape)) {
      const child = shape[key] as ZodTypeAny;
      const childDef: any = (child as any)._def;
      const isOptional =
        childDef?.typeName === "ZodOptional" || childDef?.typeName === "ZodDefault";
      properties[key] = zodFieldToJsonSchema(child);
      if (!isOptional) required.push(key);
    }
    const out: JsonSchemaObject = {
      type: "object",
      properties,
      additionalProperties: def.unknownKeys === "strict" ? false : true,
    };
    if (required.length > 0) out.required = required;
    return out;
  }

  // Fallback — permissive object schema.
  return { type: "object", properties: {}, additionalProperties: true };
}

function zodFieldToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const def: any = (schema as any)._def;
  const out = zodFieldType(schema);
  // `.optional().describe()` sets the text only on the wrapper, and a later
  // describe() overrides an earlier one — so the outermost description wins.
  const description: unknown = def?.description;
  if (typeof description === "string" && description.length > 0) {
    return { ...out, description };
  }
  return out;
}

function zodFieldType(schema: ZodTypeAny): Record<string, unknown> {
  const def: any = (schema as any)._def;
  const typeName: string = def?.typeName ?? "";
  switch (typeName) {
    case "ZodString":
      return { type: "string" };
    case "ZodNumber":
      return { type: "number" };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodEnum":
      return { type: "string", enum: [...def.values] };
    case "ZodArray":
      return { type: "array", items: zodFieldToJsonSchema(def.type) };
    case "ZodOptional":
    case "ZodDefault":
      return zodFieldToJsonSchema(def.innerType);
    case "ZodEffects":
      // .refine() / .superRefine() / .transform(): describe the input type.
      return zodFieldToJsonSchema(def.schema);
    case "ZodObject":
      return zodToJsonSchema(schema);
    default:
      return {};
  }
}
