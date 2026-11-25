import { z } from "zod";
import { projectDirField } from "../tools/verseContext.js";
import { zodToJsonSchema } from "../util/jsonSchema.js";

/**
 * `projectDir` on proxied asset tools. The installed AGENTS.md already tells
 * agents to pass it on every image-proxy call (the server's cwd may be a
 * parent folder, or not a project at all on Claude Desktop / Cursor). It is a
 * local argument: it picks the project for the jam credit top-up and the call
 * log, and is never sent upstream — a local path means nothing to the asset
 * services. A tool whose upstream schema defines its own `projectDir` keeps it
 * untouched.
 */

const PROJECT_DIR_JSON_SCHEMA = (
  zodToJsonSchema(z.object({ projectDir: projectDirField })) as { properties: Record<string, unknown> }
).properties.projectDir;

type JsonObjectSchema = { type?: unknown; properties?: Record<string, unknown>; [k: string]: unknown };

function upstreamDefinesProjectDir(schema: unknown): boolean {
  const props = (schema as JsonObjectSchema | null | undefined)?.properties;
  return !!props && typeof props === "object" && Object.prototype.hasOwnProperty.call(props, "projectDir");
}

/** The upstream input schema plus the local `projectDir` property. */
export function withProjectDirParam(schema: unknown): JsonObjectSchema {
  const base: JsonObjectSchema =
    schema && typeof schema === "object" ? (schema as JsonObjectSchema) : { type: "object", additionalProperties: true };
  if (upstreamDefinesProjectDir(base)) return base;
  return { ...base, type: base.type ?? "object", properties: { ...(base.properties ?? {}), projectDir: PROJECT_DIR_JSON_SCHEMA } };
}

export type SplitProjectDir =
  | { ok: true; projectDir: string | undefined; forwardArgs: Record<string, unknown> }
  | { ok: false; error: "invalid_input"; hint: string };

/**
 * Take the local `projectDir` out of a proxied call's arguments, checked the
 * same way as every local tool's `projectDir`.
 */
export function splitProjectDirArg(upstreamSchema: unknown, args: unknown): SplitProjectDir {
  const input = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  if (upstreamDefinesProjectDir(upstreamSchema) || !("projectDir" in input)) {
    return { ok: true, projectDir: typeof input.projectDir === "string" ? input.projectDir : undefined, forwardArgs: input };
  }
  const { projectDir, ...forwardArgs } = input;
  const parsed = projectDirField.safeParse(projectDir);
  if (!parsed.success) {
    return { ok: false, error: "invalid_input", hint: parsed.error.issues.map((i) => `projectDir: ${i.message}`).join("; ") };
  }
  return { ok: true, projectDir: parsed.data, forwardArgs };
}
