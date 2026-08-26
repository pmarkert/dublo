import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  installSkill,
  readSkillDoc,
  resolveBundledSkillDir
} from "../../src/cli/skill-commands.js";

void test("resolveBundledSkillDir points at a directory containing SKILL.md", () => {
  const dir = resolveBundledSkillDir();
  assert.ok(existsSync(path.join(dir, "SKILL.md")));
});

void test("readSkillDoc returns the skill frontmatter", async () => {
  const doc = await readSkillDoc();
  assert.match(doc, /name:\s*dublo/);
});

void test("installSkill copies the skill and its references into the target", async (t) => {
  const skillsDir = await mkdtemp(path.join(os.tmpdir(), "dublo-skill-"));
  t.after(async () => rm(skillsDir, { force: true, recursive: true }));

  const { destination } = await installSkill(skillsDir);
  assert.equal(destination, path.join(skillsDir, "dublo"));
  assert.ok(existsSync(path.join(destination, "SKILL.md")));
  assert.ok(existsSync(path.join(destination, "references", "reference.md")));
});

void test("installSkill refuses to overwrite without force, then overwrites with it", async (t) => {
  const skillsDir = await mkdtemp(path.join(os.tmpdir(), "dublo-skill-"));
  t.after(async () => rm(skillsDir, { force: true, recursive: true }));

  await installSkill(skillsDir);
  await assert.rejects(() => installSkill(skillsDir), /already installed/);
  const { destination } = await installSkill(skillsDir, { force: true });
  assert.ok(existsSync(path.join(destination, "SKILL.md")));
});
