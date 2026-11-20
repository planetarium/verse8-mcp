// The host LLM only sees the JSON Schema of each tool. zod `.describe()`
// text used to be dropped by zodToJsonSchema, so every field hint written
// in the tool schemas (projectDir, problemStatement, releaseNoteTypes, …)
// never reached the host.

import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { zodToJsonSchema } from "../../dist/util/jsonSchema.js";
import { deployInputSchema } from "../../dist/tools/deploy.js";
import { checkpointInputSchema } from "../../dist/tools/checkpoint.js";

test("jsonSchema: describe() text is emitted, wherever it sits in the chain", () => {
  const schema = zodToJsonSchema(
    z
      .object({
        inner: z.string().describe("inner text").optional(),
        outer: z.string().optional().describe("outer text"),
        both: z.string().describe("first").optional().describe("last"),
        withDefault: z.boolean().default(false).describe("flag text"),
        plain: z.string(),
      })
      .strict(),
  );
  assert.equal(schema.properties.inner.description, "inner text");
  assert.equal(schema.properties.outer.description, "outer text");
  assert.equal(schema.properties.both.description, "last");
  assert.equal(schema.properties.withDefault.description, "flag text");
  assert.equal(schema.properties.withDefault.type, "boolean");
  assert.ok(!("description" in schema.properties.plain));
});

test("jsonSchema: a refined field keeps its type and its description", () => {
  const schema = zodToJsonSchema(
    z
      .object({
        dir: z.string().min(1).refine((v) => v.startsWith("/")).optional().describe("abs path"),
      })
      .strict(),
  );
  assert.deepEqual(schema.properties.dir, { type: "string", description: "abs path" });
});

test("verse8_deploy schema: releaseNoteTypes and projectDir carry their descriptions", () => {
  const schema = zodToJsonSchema(deployInputSchema);
  assert.match(schema.properties.releaseNoteTypes.description, /Required on every deploy/);
  assert.match(schema.properties.projectDir.description, /Absolute path/);
});

test("verse8_checkpoint schema: field descriptions reach the host", () => {
  const schema = zodToJsonSchema(checkpointInputSchema);
  assert.match(schema.properties.userPrompt.description, /verbatim/);
  assert.match(schema.properties.problemStatement.description, /REQUIRED for history continuity/);
});
