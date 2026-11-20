// The host LLM only sees the JSON Schema of each tool. `z.enum` values used
// to be dropped by zodToJsonSchema (an enum field became `{}`), so e.g.
// verse8_deploy's releaseNoteTypes values (New | Improvements | Balance |
// Events | Compatibility | BugFixes) were only learned from a failed call.

import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { zodToJsonSchema } from "../../dist/util/jsonSchema.js";
import { deployInputSchema } from "../../dist/tools/deploy.js";
import { checkpointInputSchema } from "../../dist/tools/checkpoint.js";
import { previewInputSchema } from "../../dist/tools/preview.js";

test("jsonSchema: z.enum surfaces its values, also inside arrays and optionals", () => {
  const schema = zodToJsonSchema(
    z
      .object({
        mode: z.enum(["a", "b"]),
        modes: z.array(z.enum(["x", "y"])).optional(),
      })
      .strict(),
  );
  assert.deepEqual(schema.properties.mode, { type: "string", enum: ["a", "b"] });
  assert.deepEqual(schema.properties.modes.items, { type: "string", enum: ["x", "y"] });
  assert.deepEqual(schema.required, ["mode"]);
});

test("jsonSchema: refine() keeps the underlying type (was `{}`)", () => {
  const schema = zodToJsonSchema(
    z.object({ dir: z.string().min(1).refine((v) => v.startsWith("/")).optional() }).strict(),
  );
  assert.equal(schema.properties.dir.type, "string");
});

test("verse8_deploy schema: releaseNoteTypes lists the allowed values", () => {
  const schema = zodToJsonSchema(deployInputSchema);
  const rnt = schema.properties.releaseNoteTypes;
  assert.equal(rnt.type, "array");
  assert.deepEqual(rnt.items.enum, ["New", "Improvements", "Balance", "Events", "Compatibility", "BugFixes"]);
  assert.deepEqual(schema.properties.visibility.enum, ["Public", "Unlisted", "Private"]);
  assert.equal(schema.properties.projectDir.type, "string");
});

test("verse8_checkpoint / verse8_preview schema: toolCalls[].status lists completed | error", () => {
  for (const s of [checkpointInputSchema, previewInputSchema]) {
    const schema = zodToJsonSchema(s);
    const status = schema.properties.toolCalls.items.properties.status;
    assert.deepEqual(status.enum, ["completed", "error"]);
  }
});
