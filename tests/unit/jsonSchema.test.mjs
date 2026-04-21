import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { zodToJsonSchema } from "../../dist/util/jsonSchema.js";

function propType(schema, key) {
  return schema.properties?.[key]?.type;
}

test("jsonSchema: 01 — strict object with single required string", () => {
  const schema = zodToJsonSchema(z.object({ name: z.string() }).strict());
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.equal(propType(schema, "name"), "string");
  assert.deepEqual(schema.required, ["name"]);
});

test("jsonSchema: 02 — optional string is not in required", () => {
  const schema = zodToJsonSchema(
    z.object({ a: z.string(), b: z.string().optional() }).strict(),
  );
  assert.deepEqual(schema.required, ["a"]);
  assert.equal(propType(schema, "b"), "string");
});

test("jsonSchema: 03 — default value treated as optional", () => {
  const schema = zodToJsonSchema(
    z.object({ flag: z.boolean().default(false) }).strict(),
  );
  assert.ok(!schema.required || !schema.required.includes("flag"));
  assert.equal(propType(schema, "flag"), "boolean");
});

test("jsonSchema: 04 — number field", () => {
  const schema = zodToJsonSchema(z.object({ count: z.number() }).strict());
  assert.equal(propType(schema, "count"), "number");
});

test("jsonSchema: 05 — integer via zod constraint still surfaces as number", () => {
  const schema = zodToJsonSchema(z.object({ n: z.number().int() }).strict());
  assert.equal(propType(schema, "n"), "number");
});

test("jsonSchema: 06 — boolean field", () => {
  const schema = zodToJsonSchema(z.object({ on: z.boolean() }).strict());
  assert.equal(propType(schema, "on"), "boolean");
});

test("jsonSchema: 07 — array of strings", () => {
  const schema = zodToJsonSchema(
    z.object({ tags: z.array(z.string()) }).strict(),
  );
  assert.equal(propType(schema, "tags"), "array");
  assert.equal(schema.properties.tags.items.type, "string");
});

test("jsonSchema: 08 — array of numbers", () => {
  const schema = zodToJsonSchema(
    z.object({ nums: z.array(z.number()) }).strict(),
  );
  assert.equal(propType(schema, "nums"), "array");
  assert.equal(schema.properties.nums.items.type, "number");
});

test("jsonSchema: 09 — nested object field", () => {
  const schema = zodToJsonSchema(
    z.object({ addr: z.object({ city: z.string() }) }).strict(),
  );
  assert.equal(propType(schema, "addr"), "object");
  assert.equal(schema.properties.addr.properties.city.type, "string");
});

test("jsonSchema: 10 — passthrough object allows additional properties", () => {
  const schema = zodToJsonSchema(z.object({ x: z.string() }));
  assert.equal(schema.additionalProperties, true);
});

test("jsonSchema: 11 — multiple required fields preserve order", () => {
  const schema = zodToJsonSchema(
    z
      .object({ a: z.string(), b: z.string(), c: z.number() })
      .strict(),
  );
  assert.deepEqual(schema.required, ["a", "b", "c"]);
});

test("jsonSchema: 12 — all-optional object emits no required array", () => {
  const schema = zodToJsonSchema(
    z.object({ a: z.string().optional(), b: z.number().optional() }).strict(),
  );
  assert.ok(!schema.required || schema.required.length === 0);
});

test("jsonSchema: 13 — describe() does not break the type inference", () => {
  const schema = zodToJsonSchema(
    z.object({ note: z.string().describe("the user's note") }).strict(),
  );
  assert.equal(propType(schema, "note"), "string");
});

test("jsonSchema: 14 — string with min/max still reports type:string", () => {
  const schema = zodToJsonSchema(
    z.object({ slug: z.string().min(1).max(120) }).strict(),
  );
  assert.equal(propType(schema, "slug"), "string");
});

test("jsonSchema: 15 — number with min/max still reports type:number", () => {
  const schema = zodToJsonSchema(
    z.object({ age: z.number().min(0).max(150) }).strict(),
  );
  assert.equal(propType(schema, "age"), "number");
});

test("jsonSchema: 16 — optional wrapping a number is still type:number", () => {
  const schema = zodToJsonSchema(
    z.object({ n: z.number().optional() }).strict(),
  );
  assert.equal(propType(schema, "n"), "number");
});

test("jsonSchema: 17 — optional wrapping a boolean is still type:boolean", () => {
  const schema = zodToJsonSchema(
    z.object({ b: z.boolean().optional() }).strict(),
  );
  assert.equal(propType(schema, "b"), "boolean");
});

test("jsonSchema: 18 — array inside optional", () => {
  const schema = zodToJsonSchema(
    z.object({ tags: z.array(z.string()).optional() }).strict(),
  );
  assert.equal(propType(schema, "tags"), "array");
  assert.equal(schema.properties.tags.items.type, "string");
});

test("jsonSchema: 19 — deeply nested object", () => {
  const schema = zodToJsonSchema(
    z
      .object({
        level1: z.object({
          level2: z.object({ leaf: z.string() }),
        }),
      })
      .strict(),
  );
  assert.equal(
    schema.properties.level1.properties.level2.properties.leaf.type,
    "string",
  );
});

test("jsonSchema: 20 — array of objects has nested items.properties", () => {
  const schema = zodToJsonSchema(
    z
      .object({
        items: z.array(z.object({ id: z.string(), qty: z.number() })),
      })
      .strict(),
  );
  const items = schema.properties.items.items;
  assert.equal(items.type, "object");
  assert.equal(items.properties.id.type, "string");
  assert.equal(items.properties.qty.type, "number");
});

test("jsonSchema: 21 — optional object field is not in required", () => {
  const schema = zodToJsonSchema(
    z
      .object({
        addr: z.object({ city: z.string() }).optional(),
      })
      .strict(),
  );
  assert.ok(!schema.required || !schema.required.includes("addr"));
});

test("jsonSchema: 22 — default() for number is optional", () => {
  const schema = zodToJsonSchema(
    z.object({ retries: z.number().default(3) }).strict(),
  );
  assert.ok(!schema.required || !schema.required.includes("retries"));
  assert.equal(propType(schema, "retries"), "number");
});

test("jsonSchema: 23 — default() for string is optional", () => {
  const schema = zodToJsonSchema(
    z.object({ mode: z.string().default("read") }).strict(),
  );
  assert.ok(!schema.required || !schema.required.includes("mode"));
  assert.equal(propType(schema, "mode"), "string");
});

test("jsonSchema: 24 — required + optional mix emits required only for required", () => {
  const schema = zodToJsonSchema(
    z
      .object({
        id: z.string(),
        label: z.string().optional(),
        tags: z.array(z.string()).optional(),
      })
      .strict(),
  );
  assert.deepEqual(schema.required, ["id"]);
});

test("jsonSchema: 25 — empty object with strict emits additionalProperties:false", () => {
  const schema = zodToJsonSchema(z.object({}).strict());
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties, {});
});

test("jsonSchema: 26 — non-object fallback is permissive", () => {
  // Fallback branch: anything that isn't ZodObject returns permissive shape.
  const schema = zodToJsonSchema(z.string());
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, true);
});

test("jsonSchema: 27 — unknown zod variant at field level returns empty object", () => {
  // ZodUnion (unsupported) falls back to `{}` at the field level but the
  // outer object schema still reports type:object.
  const schema = zodToJsonSchema(
    z
      .object({ who: z.union([z.string(), z.number()]) })
      .strict(),
  );
  assert.equal(schema.type, "object");
  // The field survives even if we can't narrow its type.
  assert.ok("who" in schema.properties);
});

test("jsonSchema: 28 — array of arrays", () => {
  const schema = zodToJsonSchema(
    z.object({ matrix: z.array(z.array(z.number())) }).strict(),
  );
  assert.equal(schema.properties.matrix.items.type, "array");
  assert.equal(schema.properties.matrix.items.items.type, "number");
});

test("jsonSchema: 29 — round-trip of a realistic MCP input schema shape", () => {
  const schema = zodToJsonSchema(
    z
      .object({
        projectDir: z.string().describe("absolute path").optional(),
        overwriteAgentsDoc: z.boolean().default(false),
        overwriteAllSkills: z.boolean().default(false),
        pruneOrphanedSkills: z.boolean().default(false),
        overwriteEnv: z.boolean().default(false),
      })
      .strict(),
  );
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  for (const k of [
    "projectDir",
    "overwriteAgentsDoc",
    "overwriteAllSkills",
    "pruneOrphanedSkills",
    "overwriteEnv",
  ]) {
    assert.ok(k in schema.properties, `missing ${k}`);
  }
  // All are optional / default, so required should be absent or empty.
  assert.ok(!schema.required || schema.required.length === 0);
});

test("jsonSchema: 30 — empty required array is dropped", () => {
  const schema = zodToJsonSchema(
    z.object({ a: z.string().optional() }).strict(),
  );
  // Adapter only emits `required` when length > 0.
  assert.ok(!("required" in schema) || schema.required.length > 0);
});

test("jsonSchema: 31 — existing tool input schemas compile through adapter (no throw)", () => {
  // Smoke check across the real tool input schemas — failure would ship a
  // broken MCP descriptor to every host LLM.
  const schemas = [
    z.object({}).strict(),
    z.object({ projectDir: z.string().optional() }).strict(),
    z
      .object({
        userRequest: z.string().min(1),
        projectPath: z.string().optional(),
      })
      .strict(),
    z
      .object({
        templateName: z.string(),
        repo: z.string(),
        path: z.string(),
        title: z.string().optional(),
        startCallId: z.string().optional(),
      })
      .strict(),
    z
      .object({
        device_code: z.string(),
        max_wait_seconds: z.number().default(120),
      })
      .strict(),
  ];
  for (const s of schemas) {
    const out = zodToJsonSchema(s);
    assert.equal(out.type, "object");
  }
});
