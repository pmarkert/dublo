import assert from "node:assert/strict";
import test from "node:test";
import { isWorkspaceDefaultProfile } from "../../src/commands/llm/configure.js";

void test("detects when the configured LLM profile is already the workspace default", () => {
  assert.equal(isWorkspaceDefaultProfile("default", "default"), true);
  assert.equal(isWorkspaceDefaultProfile("default", "haiku"), false);
  assert.equal(isWorkspaceDefaultProfile("", "default"), false);
});
