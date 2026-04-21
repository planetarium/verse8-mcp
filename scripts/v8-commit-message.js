#!/usr/bin/env node
// Standalone deterministic V8 commit-message builder CLI.
// Reads JSON from stdin (or a file arg), writes the assembled message to stdout.
//
// Usage:
//   echo '{"userPrompt":"…","model":"…","toolCalls":[…]}' | scripts/v8-commit-message.js
//   scripts/v8-commit-message.js path/to/input.json
//
// Schema matches V8CommitInput in src/format/v8CommitMessage.ts. Requires
// the package to be built (dist/format/v8CommitMessage.js must exist).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const builderPath = join(__dirname, "..", "dist", "format", "v8CommitMessage.js");

let buildV8CommitMessage;
try {
  ({ buildV8CommitMessage } = await import(builderPath));
} catch (err) {
  process.stderr.write(
    `cannot load ${builderPath}: ${err.message}\n` +
      "run `npm run build` first.\n",
  );
  process.exit(1);
}

const arg = process.argv[2];
let raw;
if (arg) {
  raw = readFileSync(arg, "utf8");
} else {
  raw = readFileSync(0, "utf8");
}

let input;
try {
  input = JSON.parse(raw);
} catch (err) {
  process.stderr.write(`invalid JSON input: ${err.message}\n`);
  process.exit(2);
}

try {
  const msg = buildV8CommitMessage(input);
  process.stdout.write(msg);
  if (!msg.endsWith("\n")) process.stdout.write("\n");
} catch (err) {
  process.stderr.write(`builder error: ${err.message}\n`);
  process.exit(3);
}
