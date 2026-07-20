import assert from "node:assert/strict";
import test from "node:test";
import { parseEditorCommand } from "../../src/utils/editor.js";

void test("editor command parser supports quoted executables and arguments without a shell", () => {
  assert.deepEqual(parseEditorCommand('"/Applications/Visual Studio Code.app/bin/code" --wait'), [
    "/Applications/Visual Studio Code.app/bin/code",
    "--wait"
  ]);
});

void test("editor command parser rejects unterminated quotes", () => {
  assert.throws(() => parseEditorCommand('"code --wait'), /unterminated/);
});
