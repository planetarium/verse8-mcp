import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  renderSkillsCatalog,
  escapeCell,
  extractSkillDescription,
  truncateDescription,
} from "../../dist/resources/skillCatalog.js";

function tmpSkill(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verse8-skill-cat-"));
  const fsPath = path.join(dir, "SKILL.md");
  fs.writeFileSync(fsPath, content);
  return { dir, fsPath };
}

test("renderSkillsCatalog: empty array → fallback message", () => {
  const out = renderSkillsCatalog([]);
  assert.match(out, /Available Verse8 skills/);
  assert.match(out, /no skills bundled/);
});

test("renderSkillsCatalog: skill with frontmatter description", () => {
  const { dir, fsPath } = tmpSkill(
    "---\ndescription: A handy helper\n---\n# Title\nbody\n",
  );
  try {
    const out = renderSkillsCatalog([
      { uri: "verse8://skill/foo/SKILL.md", name: "foo", mimeType: "text/markdown", fsPath },
    ]);
    assert.match(out, /\| `foo` \| A handy helper \| `verse8:\/\/skill\/foo\/SKILL\.md` \|/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("renderSkillsCatalog: skill without description → fallback", () => {
  const { dir, fsPath } = tmpSkill("# Just a title\n");
  try {
    const out = renderSkillsCatalog([
      { uri: "verse8://skill/bar/SKILL.md", name: "bar", mimeType: "text/markdown", fsPath },
    ]);
    // First non-blank line after H1 is the fallback path; this fixture has none.
    assert.match(out, /\| `bar` \| \(no description\) \|/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("escapeCell: pipes escaped + newlines collapsed", () => {
  const got = escapeCell("a | b\n  c\nd");
  assert.equal(got, "a \\| b c d");
});

test("truncateDescription: caps at 160 chars with ellipsis", () => {
  const long = "x".repeat(200);
  const out = truncateDescription(long);
  assert.ok(out.length <= 160);
  assert.match(out, /…$/);
});

test("extractSkillDescription: block scalar (description: |)", () => {
  const raw = [
    "---",
    "name: foo",
    "description: |",
    "  multi-line",
    "  block scalar",
    "other: thing",
    "---",
    "body",
  ].join("\n");
  const got = extractSkillDescription(raw);
  assert.equal(got, "multi-line block scalar");
});

test("extractSkillDescription: inline string with quotes stripped", () => {
  const raw = `---\ndescription: "quoted desc"\n---\nbody\n`;
  const got = extractSkillDescription(raw);
  assert.equal(got, "quoted desc");
});

test("extractSkillDescription: falls back to first non-blank after H1", () => {
  const raw = "# Heading\n\nfirst body line\nsecond body line\n";
  const got = extractSkillDescription(raw);
  assert.equal(got, "first body line");
});
