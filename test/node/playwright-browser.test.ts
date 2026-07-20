import assert from "node:assert/strict";
import test from "node:test";
import { createPlaywrightBrowserFactory } from "../../src/node/playwright-browser.js";

void test("Playwright browser factory owns context and browser shutdown", async () => {
  const closed: string[] = [];
  const page = { id: "page" };
  const factory = createPlaywrightBrowserFactory({
    launch(options) {
      assert.equal(options.headless, false);
      return Promise.resolve({
        newContext(contextOptions) {
          assert.deepEqual(contextOptions.viewport, { width: 1440, height: 900 });
          return Promise.resolve({
            newPage() {
              return Promise.resolve(page);
            },
            close() {
              closed.push("context");
              return Promise.resolve();
            }
          });
        },
        close() {
          closed.push("browser");
          return Promise.resolve();
        }
      });
    }
  });

  const session = await factory.launch({ headed: true, viewport: { width: 1440, height: 900 } });
  assert.equal(session.page, page);
  await session.close();
  assert.deepEqual(closed, ["context", "browser"]);
});
