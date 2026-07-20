import assert from "node:assert/strict";
import test from "node:test";
import { defaultViewerCommand } from "../../src/utils/open-file.js";

void test("selects the default viewer command for each supported platform", () => {
  assert.deepEqual(defaultViewerCommand("/tmp/summary.html", "darwin"), {
    command: "open",
    args: ["/tmp/summary.html"]
  });
  assert.deepEqual(defaultViewerCommand("C:\\reports\\summary.html", "win32"), {
    command: "cmd",
    args: ["/c", "start", "", "C:\\reports\\summary.html"]
  });
  assert.deepEqual(defaultViewerCommand("/tmp/summary.html", "linux"), {
    command: "xdg-open",
    args: ["/tmp/summary.html"]
  });
});
