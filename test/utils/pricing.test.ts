import assert from "node:assert/strict";
import test from "node:test";
import {
  addTokenUsageTotals,
  calculateCostEstimate,
  getConfiguredModelPricing,
  subtractTokenUsage
} from "../../src/utils/scenario/pricing.mjs";

void test("aggregates planner token usage including cache tokens", () => {
  const total = {
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
    cacheReadInputTokens: 4,
    cacheWriteInputTokens: 5,
    plannerCalls: 0
  };
  addTokenUsageTotals(total, {
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
    cacheReadInputTokens: 40,
    cacheWriteInputTokens: 50
  });
  assert.deepEqual(total, {
    inputTokens: 11,
    outputTokens: 22,
    totalTokens: 33,
    cacheReadInputTokens: 44,
    cacheWriteInputTokens: 55,
    plannerCalls: 1
  });
});

void test("resolves configured rates and calculates each cost component", () => {
  const pricing = getConfiguredModelPricing({
    llm: {
      inputPrice: 2,
      outputPrice: 4,
      cacheReadPrice: 1,
      cacheWritePrice: 3,
      tokenUnit: 100,
      currency: "USD"
    }
  });
  assert.deepEqual(
    calculateCostEstimate(
      { inputTokens: 50, outputTokens: 25, cacheReadInputTokens: 20, cacheWriteInputTokens: 10 },
      pricing
    ),
    {
      currency: "USD",
      tokenUnit: 100,
      rates: {
        inputUsdPerUnit: 2,
        outputUsdPerUnit: 4,
        cacheReadUsdPerUnit: 1,
        cacheWriteUsdPerUnit: 3
      },
      costs: { input: 1, output: 1, cacheRead: 0.2, cacheWrite: 0.3, total: 2.5 }
    }
  );
});

void test("subtractTokenUsage derives the primary tier's share and never goes negative", () => {
  const total = {
    inputTokens: 1000,
    outputTokens: 400,
    totalTokens: 1400,
    cacheReadInputTokens: 200,
    cacheWriteInputTokens: 100
  };
  const escalation = {
    inputTokens: 300,
    outputTokens: 150,
    totalTokens: 450,
    cacheReadInputTokens: 250,
    cacheWriteInputTokens: 0
  };
  assert.deepEqual(subtractTokenUsage(total, escalation), {
    inputTokens: 700,
    outputTokens: 250,
    totalTokens: 950,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 100
  });
});
