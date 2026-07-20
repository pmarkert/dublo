import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPlannerMessages,
  classifyRecoverableActionError,
  isDocumentTextGone,
  loadContextFromOperations,
  redactSecretValues,
  resolveFillValue
} from "../../src/utils/scenario-runner.mjs";

void test("detects when observed document text has disappeared", () => {
  assert.equal(isDocumentTextGone("Checking your account...", "checking YOUR account"), false);
  assert.equal(isDocumentTextGone("Welcome back", "Checking your account..."), true);
});

void test("treats targets that disappear during a transition as recoverable", () => {
  assert.equal(
    classifyRecoverableActionError(new Error("Planner target not found: a4")),
    "target_disappeared"
  );
});

void test("environment-backed secrets stay out of planner context and resolve only for fills", async () => {
  const { contextData, secretValues } = await loadContextFromOperations(
    [{ type: "secret", value: "checkout.password=CHECKOUT_PASSWORD" }],
    { CHECKOUT_PASSWORD: "correct-horse-battery-staple" }
  );

  assert.deepEqual(contextData, {});
  assert.deepEqual([...secretValues.keys()], ["checkout.password"]);
  assert.equal(
    resolveFillValue("{{secret:checkout.password}}", contextData, new Map(), secretValues),
    "correct-horse-battery-staple"
  );

  const messages = buildPlannerMessages({
    testPrompt: "Sign in.",
    personaText: "Test persona.",
    workspacePromptText: "",
    contextData,
    secretValues,
    observation: {
      url: "https://example.test",
      title: "Sign in",
      modal: {},
      headings: [],
      alerts: [],
      documentText: "correct-horse-battery-staple",
      controls: []
    },
    actionHistory: [],
    humanInputs: new Map(),
    screenshotRequested: false
  });

  assert.match(messages.staticContextText, /checkout\.password/);
  assert.doesNotMatch(messages.staticContextText, /correct-horse-battery-staple/);
  assert.match(messages.dynamicContextText, /\*{7}/);
  assert.doesNotMatch(messages.dynamicContextText, /correct-horse-battery-staple/);
});

void test("secret redaction masks only exact string matches", () => {
  const redacted: unknown = redactSecretValues(
    { exact: "token", embedded: "prefix-token", nested: ["token"] },
    new Map([["auth.token", "token"]])
  );

  assert.deepEqual(redacted, { exact: "*******", embedded: "prefix-token", nested: ["*******"] });
});

void test("DUBLO_SECRET variables are discovered without a CLI secret operation", async () => {
  const { secretValues } = await loadContextFromOperations([], {
    DUBLO_SECRET_password: "correct-horse-battery-staple",
    DUBLO_SECRET_checkout__token: "checkout-token"
  });

  assert.deepEqual([...secretValues.keys()], ["checkout.token", "password"]);
  assert.equal(secretValues.get("password"), "correct-horse-battery-staple");
});

void test("bare secret references require their DUBLO_SECRET variable", async () => {
  await assert.rejects(
    () => loadContextFromOperations([{ type: "secret", value: "password" }], {}),
    /Secret environment variable 'DUBLO_SECRET_password' is not set or is empty/
  );
});

void test("empty DUBLO_SECRET variables fail loudly", async () => {
  await assert.rejects(
    () => loadContextFromOperations([], { DUBLO_SECRET_password: "" }),
    /Secret environment variable 'DUBLO_SECRET_password' is not set or is empty/
  );
});
