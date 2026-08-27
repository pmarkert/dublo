import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeErrorTracker } from "../../src/utils/scenario/runtime-errors.mjs";

type Handler = (payload: unknown) => void;

// Minimal Playwright-page stand-in that lets tests emit the events the tracker
// subscribes to.
function createFakePage() {
  const handlers = new Map<string, Set<Handler>>();
  return {
    on(event: string, handler: Handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)?.add(handler);
    },
    off(event: string, handler: Handler) {
      handlers.get(event)?.delete(handler);
    },
    emit(event: string, payload: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
    handlerCount(event: string) {
      return handlers.get(event)?.size ?? 0;
    }
  };
}

void test("runtime error tracker captures console errors, page errors, and bad responses", () => {
  const page = createFakePage();
  const tracker = createRuntimeErrorTracker(page);

  page.emit("console", { type: () => "log", text: () => "just info" });
  page.emit("console", {
    type: () => "error",
    text: () => "Uncaught TypeError: x is not a function"
  });
  page.emit("pageerror", new Error("boom"));
  page.emit("response", {
    status: () => 500,
    url: () => "https://api.example.com/orders",
    request: () => ({ method: () => "POST" })
  });
  page.emit("response", {
    status: () => 200,
    url: () => "https://api.example.com/ok",
    request: () => ({ method: () => "GET" })
  });

  const drained = tracker.drain();
  assert.equal(drained.length, 3);
  assert.deepEqual(drained[0], {
    type: "console",
    text: "Uncaught TypeError: x is not a function"
  });
  assert.equal(drained[1].type, "pageerror");
  assert.match(drained[1].text, /boom/);
  assert.deepEqual(drained[2], {
    type: "response",
    status: 500,
    method: "POST",
    url: "https://api.example.com/orders"
  });

  // Draining clears the buffer.
  assert.deepEqual(tracker.drain(), []);
});

void test("runtime error tracker records and dismisses native dialogs", () => {
  const page = createFakePage();
  const tracker = createRuntimeErrorTracker(page);
  let dismissed = false;

  page.emit("dialog", {
    type: () => "alert",
    message: () => "Are you sure?",
    dismiss: () => {
      dismissed = true;
      return Promise.resolve();
    }
  });

  const drained = tracker.drain();
  assert.deepEqual(drained, [{ type: "dialog", dialogType: "alert", text: "Are you sure?" }]);
  assert.equal(dismissed, true);
});

void test("runtime error tracker ignores routine aborted requests and detaches on dispose", () => {
  const page = createFakePage();
  const tracker = createRuntimeErrorTracker(page);

  page.emit("requestfailed", {
    method: () => "GET",
    url: () => "https://example.com/cancelled",
    failure: () => ({ errorText: "net::ERR_ABORTED" })
  });
  page.emit("requestfailed", {
    method: () => "GET",
    url: () => "https://example.com/down",
    failure: () => ({ errorText: "net::ERR_CONNECTION_REFUSED" })
  });

  const drained = tracker.drain();
  assert.equal(drained.length, 1);
  assert.equal(drained[0].url, "https://example.com/down");

  assert.ok(page.handlerCount("console") > 0);
  tracker.dispose();
  assert.equal(page.handlerCount("console"), 0);
  assert.equal(page.handlerCount("dialog"), 0);
});

void test("runtime error tracker caps the buffer and notes dropped entries", () => {
  const page = createFakePage();
  const tracker = createRuntimeErrorTracker(page, { maxEntries: 2 });

  for (const index of [1, 2, 3]) {
    page.emit("pageerror", new Error(`error ${index}`));
  }

  const drained = tracker.drain();
  assert.equal(drained[0].type, "note");
  assert.match(drained[0].text, /dropped/);
  assert.match(drained[drained.length - 1].text, /error 3/);
});
