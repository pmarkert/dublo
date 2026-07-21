function toNumberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function addTokenUsageTotals(target, delta) {
  if (!target || !delta) return;

  target.inputTokens += toNumberOrZero(delta.inputTokens);
  target.outputTokens += toNumberOrZero(delta.outputTokens);
  target.totalTokens += toNumberOrZero(delta.totalTokens);
  target.cacheReadInputTokens += toNumberOrZero(delta.cacheReadInputTokens);
  target.cacheWriteInputTokens += toNumberOrZero(delta.cacheWriteInputTokens);
  target.plannerCalls += 1;
}

export function getConfiguredModelPricing(config) {
  const inputOverride = toNumberOrZero(config.llm.inputPrice);
  const outputOverride = toNumberOrZero(config.llm.outputPrice);
  const hasInputOverride = Number.isFinite(Number(config.llm.inputPrice));
  const hasOutputOverride = Number.isFinite(Number(config.llm.outputPrice));
  if (!hasInputOverride && !hasOutputOverride) return null;

  const base = {
    currency: config.llm.currency || "USD",
    tokenUnit: Number.isFinite(Number(config.llm.tokenUnit)) ? Number(config.llm.tokenUnit) : 1000000,
    inputUsdPerUnit: 0,
    outputUsdPerUnit: 0,
    cacheReadUsdPerUnit: toNumberOrZero(config.llm.cacheReadPrice),
    cacheWriteUsdPerUnit: toNumberOrZero(config.llm.cacheWritePrice),
  };
  return {
    ...base,
    inputUsdPerUnit: hasInputOverride ? inputOverride : toNumberOrZero(base.inputUsdPerUnit),
    outputUsdPerUnit: hasOutputOverride ? outputOverride : toNumberOrZero(base.outputUsdPerUnit),
  };
}

export function calculateCostEstimate(tokenUsage, pricing) {
  if (!tokenUsage || !pricing) return null;

  const divisor = Number(pricing.tokenUnit);
  if (!Number.isFinite(divisor) || divisor <= 0) return null;

  const inputCost = (toNumberOrZero(tokenUsage.inputTokens) / divisor) * toNumberOrZero(pricing.inputUsdPerUnit);
  const outputCost = (toNumberOrZero(tokenUsage.outputTokens) / divisor) * toNumberOrZero(pricing.outputUsdPerUnit);
  const cacheReadCost = (toNumberOrZero(tokenUsage.cacheReadInputTokens) / divisor) * toNumberOrZero(pricing.cacheReadUsdPerUnit);
  const cacheWriteCost = (toNumberOrZero(tokenUsage.cacheWriteInputTokens) / divisor) * toNumberOrZero(pricing.cacheWriteUsdPerUnit);
  const totalCost = inputCost + outputCost + cacheReadCost + cacheWriteCost;

  return {
    currency: pricing.currency,
    tokenUnit: pricing.tokenUnit,
    rates: {
      inputUsdPerUnit: pricing.inputUsdPerUnit,
      outputUsdPerUnit: pricing.outputUsdPerUnit,
      cacheReadUsdPerUnit: pricing.cacheReadUsdPerUnit,
      cacheWriteUsdPerUnit: pricing.cacheWriteUsdPerUnit,
    },
    costs: {
      input: Number(inputCost.toFixed(10)),
      output: Number(outputCost.toFixed(10)),
      cacheRead: Number(cacheReadCost.toFixed(10)),
      cacheWrite: Number(cacheWriteCost.toFixed(10)),
      total: Number(totalCost.toFixed(10)),
    },
  };
}