const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyCrossSectionalRankScore,
  applyBenchmarkRelativeMetrics,
  applyIndustryMomentumMetrics,
  adaptivePortfolioStats,
  assignRecommendedWeights,
  auditUniverseFields,
  benchmarkOverlayWeight,
  benchmarkReturn,
  defaultParams,
  sliceKline,
  scoreAtDate,
  evaluatePeriod,
  marketSymbol,
  optimizeParams,
  paramGrid,
  parseCsv,
  weightedReturn,
  welchTTest,
  walkForwardEnsembleOptimize,
  walkForwardOptimize,
  walkForwardPoolSelect,
} = require("./lib/backtest_engine");

const fixtureRows = [
  { code: "000001", name: "AlphaA", market: "深主板", relevance: "核心", concepts: "机器人概念|传感器" },
  { code: "000002", name: "AlphaB", market: "深主板", relevance: "接口相关候选", concepts: "机器人概念" },
  { code: "000003", name: "AlphaC", market: "深主板", relevance: "核心", concepts: "机器人概念|机器视觉" },
];

function makeKline(startPrice, stepBefore, stepAfter) {
  const rows = [];
  let price = startPrice;
  for (let day = 1; day <= 8; day += 1) {
    const date = `2026-04-0${day}`;
    const step = day <= 4 ? stepBefore : stepAfter;
    price += step;
    rows.push({ date, open: price - 0.2, close: price, high: price + 0.3, low: price - 0.4, volume: 10000 + day * 100 });
  }
  return rows;
}

function makePatternKline(startDate, closes, volumes) {
  const start = new Date(`${startDate}T00:00:00Z`);
  return closes.map((close, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    const prev = index > 0 ? closes[index - 1] : close;
    const volume = volumes?.[index] ?? 1_000_000;
    return {
      date: date.toISOString().slice(0, 10),
      open: prev,
      close,
      high: Math.max(prev, close) * 1.01,
      low: Math.min(prev, close) * 0.99,
      volume,
      amount: close * volume,
    };
  });
}

function defaultRankParams() {
  return {
    momentumWeight: 0.48,
    liquidityWeight: 0.18,
    stabilityWeight: 0.18,
    themeWeight: 0.16,
  };
}

test("sliceKline excludes data after asOf when scoring and includes future window only for returns", () => {
  const kline = makeKline(10, 1, -3);
  const sliced = sliceKline(kline, "2026-04-04", "2026-04-08");
  assert.deepEqual(sliced.history.map((r) => r.date), ["2026-04-01", "2026-04-02", "2026-04-03", "2026-04-04"]);
  assert.deepEqual(sliced.future.map((r) => r.date), ["2026-04-04", "2026-04-05", "2026-04-06", "2026-04-07", "2026-04-08"]);
});

test("scoreAtDate does not reward a stock for gains that happen only after asOf", () => {
  const beforeWeakAfterStrong = makeKline(10, -0.1, 5);
  const beforeStrongAfterWeak = makeKline(10, 1, -2);

  const weakScore = scoreAtDate(fixtureRows[0], beforeWeakAfterStrong, "2026-04-04", {
    momentumWeight: 0.55,
    liquidityWeight: 0.15,
    stabilityWeight: 0.15,
    themeWeight: 0.15,
  });
  const strongScore = scoreAtDate(fixtureRows[1], beforeStrongAfterWeak, "2026-04-04", {
    momentumWeight: 0.55,
    liquidityWeight: 0.15,
    stabilityWeight: 0.15,
    themeWeight: 0.15,
  });

  assert.ok(strongScore.score > weakScore.score, `expected pre-asOf trend to dominate: ${strongScore.score} vs ${weakScore.score}`);
});

test("scoreAtDate can neutralize static theme fields to avoid current concept leakage", () => {
  const kline = makeKline(10, 1, 0.2);
  const conceptHeavy = { code: "000001", name: "ThemeA", market: "深主板", relevance: "核心", concepts: "机器人概念|机器视觉|低空经济", source: "manual_core_supplement" };
  const conceptLight = { code: "000002", name: "ThemeB", market: "深主板", relevance: "", concepts: "", source: "" };
  const enabledA = scoreAtDate(conceptHeavy, kline, "2026-04-04", {
    momentumWeight: 0.35,
    liquidityWeight: 0.15,
    stabilityWeight: 0.15,
    themeWeight: 0.35,
    minHistoryDays: 2,
  });
  const enabledB = scoreAtDate(conceptLight, kline, "2026-04-04", {
    momentumWeight: 0.35,
    liquidityWeight: 0.15,
    stabilityWeight: 0.15,
    themeWeight: 0.35,
    minHistoryDays: 2,
  });
  const disabledA = scoreAtDate(conceptHeavy, kline, "2026-04-04", {
    momentumWeight: 0.35,
    liquidityWeight: 0.15,
    stabilityWeight: 0.15,
    themeWeight: 0.35,
    minHistoryDays: 2,
    staticThemeScore: false,
  });
  const disabledB = scoreAtDate(conceptLight, kline, "2026-04-04", {
    momentumWeight: 0.35,
    liquidityWeight: 0.15,
    stabilityWeight: 0.15,
    themeWeight: 0.35,
    minHistoryDays: 2,
    staticThemeScore: false,
  });

  assert.ok(enabledA.score > enabledB.score, `expected static theme fields to influence default score: ${enabledA.score} vs ${enabledB.score}`);
  assert.equal(disabledA.themeScore, 50);
  assert.equal(disabledB.themeScore, 50);
  assert.equal(disabledA.score, disabledB.score);
});

test("parseCsv handles CRLF line endings without polluting header names", () => {
  const rows = parseCsv("date,open,volume\r\n2026-01-02,10,12345\r\n");

  assert.deepEqual(Object.keys(rows[0]), ["date", "open", "volume"]);
  assert.equal(rows[0].volume, "12345");
});

test("scoreAtDate does not reward missing turnover with fallback liquidity", () => {
  const noTurnover = makePatternKline(
    "2026-01-01",
    [10, 10.1, 10.2, 10.3, 10.4, 10.5],
    [1000000, 1000000, 1000000, 1000000, 1000000, 1000000]
  ).map(({ amount, volume, ...row }) => row);

  const score = scoreAtDate(fixtureRows[0], noTurnover, "2026-01-06", {
    momentumWeight: 0,
    liquidityWeight: 1,
    stabilityWeight: 0,
    themeWeight: 0,
    minHistoryDays: 4,
  });

  assert.equal(score.avgTurnover20, 0);
  assert.equal(score.liquidityScore, 0);
  assert.equal(score.score, 0);
});

test("auditUniverseFields flags snapshot fields and scoring-used PIT risks", () => {
  const audit = auditUniverseFields([
    {
      code: "920011",
      name: "晨光电机",
      market: "北交所/新三板系",
      industry: "电机Ⅱ",
      concepts: "机器人概念|电机Ⅱ",
      relevance: "接口核心候选",
      source: "eastmoney_concept",
      price: "25.96",
      pct_chg: "4.01",
      pe: "33.76",
      pb: "2.53",
      total_mv: "2146026675",
    },
  ], { asOfRange: "2026-04-01:2026-06-01", snapshotDate: "2026-06-04" });

  const byField = new Map(audit.fields.map((field) => [field.field, field]));
  assert.equal(byField.get("price").classification, "current_market_snapshot");
  assert.equal(byField.get("price").usedByScoring, false);
  assert.equal(byField.get("concepts").classification, "current_theme_snapshot");
  assert.equal(byField.get("concepts").usedByScoring, true);
  assert.equal(byField.get("industry").classification, "current_industry_snapshot");
  assert.equal(byField.get("industry").usedByScoring, true);
  assert.ok(audit.summary.usedHighRiskFields.includes("concepts"));
  assert.ok(audit.summary.usedHighRiskFields.includes("industry"));
  assert.ok(audit.summary.ignoredHighRiskFields.includes("pe"));
  assert.match(audit.summary.warning, /point-in-time/);
});

test("evaluatePeriod selects topN by score and computes excess return versus universe", () => {
  const klineByCode = new Map([
    ["000001", makeKline(10, 1, 2)],
    ["000002", makeKline(10, -0.2, 0.1)],
    ["000003", makeKline(10, 0.5, -1)],
  ]);
  const result = evaluatePeriod({
    universe: fixtureRows,
    klineByCode,
    asOf: "2026-04-04",
    end: "2026-04-08",
    topN: 1,
    params: { momentumWeight: 0.55, liquidityWeight: 0.15, stabilityWeight: 0.15, themeWeight: 0.15 },
  });

  assert.equal(result.top.length, 1);
  assert.equal(result.top[0].code, "000001");
  assert.ok(result.topMeanReturn > result.universeMeanReturn);
  assert.ok(result.excessReturn > 0);
});

test("assignRecommendedWeights creates bounded weights and weightedReturn uses them", () => {
  const weighted = assignRecommendedWeights([
    { code: "000001", score: 96, liquidityScore: 95, stabilityScore: 80, vol20: 0.25, dd60: -0.04, forwardReturn: 0.20 },
    { code: "000002", score: 91, liquidityScore: 88, stabilityScore: 70, vol20: 0.45, dd60: -0.08, forwardReturn: 0.10 },
    { code: "000003", score: 88, liquidityScore: 55, stabilityScore: 25, vol20: 1.10, dd60: -0.35, forwardReturn: -0.10 },
  ], { minWeight: 0.10, maxWeight: 0.60 });

  const totalWeight = weighted.reduce((sum, row) => sum + row.recommendedWeight, 0);
  assert.ok(Math.abs(totalWeight - 1) < 1e-10);
  assert.ok(weighted.every((row) => row.recommendedWeight >= 0.10 && row.recommendedWeight <= 0.60));
  assert.ok(weighted[0].recommendedWeight > weighted[2].recommendedWeight);
  assert.equal(
    Number(weightedReturn(weighted).toFixed(6)),
    Number(weighted.reduce((sum, row) => sum + row.recommendedWeight * row.forwardReturn, 0).toFixed(6))
  );
});

test("assignRecommendedWeights reduces allocation to high execution-cost stocks", () => {
  const weighted = assignRecommendedWeights([
    { code: "000001", score: 92, liquidityScore: 80, stabilityScore: 70, vol20: 0.35, dd60: -0.05, executionCostRate: 0.004, forwardReturn: 0.10 },
    { code: "000002", score: 92, liquidityScore: 80, stabilityScore: 70, vol20: 0.35, dd60: -0.05, executionCostRate: 0.025, forwardReturn: 0.10 },
    { code: "000003", score: 90, liquidityScore: 78, stabilityScore: 70, vol20: 0.35, dd60: -0.05, executionCostRate: 0.006, forwardReturn: 0.10 },
  ], { minWeight: 0.10, maxWeight: 0.70 });

  assert.ok(weighted[0].recommendedWeight > weighted[1].recommendedWeight);
  assert.ok(weighted[2].recommendedWeight > weighted[1].recommendedWeight);
});

test("assignRecommendedWeights tilts allocation toward constructive pullback accumulation", () => {
  const weighted = assignRecommendedWeights([
    { code: "000001", score: 90, liquidityScore: 80, stabilityScore: 70, vol20: 0.35, dd60: -0.05, executionCostRate: 0.006, pullbackAccumulationScore: 88, forwardReturn: 0.10 },
    { code: "000002", score: 90, liquidityScore: 80, stabilityScore: 70, vol20: 0.35, dd60: -0.05, executionCostRate: 0.006, pullbackAccumulationScore: 24, forwardReturn: 0.10 },
    { code: "000003", score: 90, liquidityScore: 80, stabilityScore: 70, vol20: 0.35, dd60: -0.05, executionCostRate: 0.006, pullbackAccumulationScore: 50, forwardReturn: 0.10 },
  ], { minWeight: 0.05, maxWeight: 0.80, pullbackTilt: 0.18 });

  assert.ok(weighted[0].recommendedWeight > weighted[2].recommendedWeight);
  assert.ok(weighted[2].recommendedWeight > weighted[1].recommendedWeight);
});

test("evaluatePeriod reports weighted top return and benchmark excess return", () => {
  const klineByCode = new Map([
    ["000001", makeKline(10, 1, 2)],
    ["000002", makeKline(10, 0.8, -0.1)],
    ["000003", makeKline(10, 0.5, 0.2)],
  ]);
  const result = evaluatePeriod({
    universe: fixtureRows,
    klineByCode,
    asOf: "2026-04-04",
    end: "2026-04-08",
    topN: 2,
    params: { momentumWeight: 0.55, liquidityWeight: 0.15, stabilityWeight: 0.15, themeWeight: 0.15 },
    benchmarkReturn: 0.04,
  });

  assert.equal(result.top.length, 2);
  assert.ok(Number.isFinite(result.weightedTopReturn));
  assert.equal(Number(result.weightedExcessVsBenchmark.toFixed(6)), Number((result.weightedTopReturn - 0.04).toFixed(6)));
  assert.equal(Number(result.topExcessVsBenchmark.toFixed(6)), Number((result.topMeanReturn - 0.04).toFixed(6)));
  assert.ok(result.top.every((row) => Number.isFinite(row.recommendedWeight)));
});

test("evaluatePeriod applies execution costs and reports net portfolio returns", () => {
  const klineByCode = new Map([
    ["000001", makeKline(10, 1, 2)],
    ["000002", makeKline(10, 0.8, 1.6)],
    ["000003", makeKline(10, 0.5, 0.2)],
  ]);
  const result = evaluatePeriod({
    universe: fixtureRows,
    klineByCode,
    asOf: "2026-04-04",
    end: "2026-04-08",
    topN: 2,
    params: {
      momentumWeight: 0.55,
      liquidityWeight: 0.15,
      stabilityWeight: 0.15,
      themeWeight: 0.15,
      executionCost: {
        enabled: true,
        roundTripBps: 40,
        maxLiquidityBps: 120,
        maxVolatilityBps: 80,
        liquidityReference: 1_000_000_000,
        liquidityFloor: 10_000_000,
      },
    },
    benchmarkReturn: 0.04,
  });

  assert.ok(result.top.every((row) => Number.isFinite(row.executionCostRate)));
  assert.ok(result.top.every((row) => row.netForwardReturn < row.forwardReturn));
  assert.ok(result.netWeightedTopReturn < result.weightedTopReturn);
  assert.equal(
    Number(result.netWeightedTopReturn.toFixed(6)),
    Number(weightedReturn(result.top, "netForwardReturn").toFixed(6))
  );
  assert.ok(Number.isFinite(result.netAdaptiveExcessVsBenchmark));
});

test("evaluatePeriod skips implausible future returns before portfolio ranking", () => {
  const pollutedCorporateActionKline = [
    { date: "2026-04-01", open: 1.05, close: 1.10, high: 1.12, low: 1.04, volume: 200_000_000, amount: 220_000_000 },
    { date: "2026-04-02", open: 1.10, close: 1.20, high: 1.22, low: 1.08, volume: 210_000_000, amount: 252_000_000 },
    { date: "2026-04-03", open: 12.00, close: 12.00, high: 12.20, low: 11.80, volume: 12_000_000, amount: 144_000_000 },
    { date: "2026-04-04", open: 12.10, close: 12.10, high: 12.30, low: 12.00, volume: 13_000_000, amount: 157_300_000 },
  ];
  const normalKline = [
    { date: "2026-04-01", open: 9.8, close: 10.0, high: 10.2, low: 9.7, volume: 1_000_000, amount: 10_000_000 },
    { date: "2026-04-02", open: 10.1, close: 10.5, high: 10.7, low: 10.0, volume: 1_200_000, amount: 12_600_000 },
    { date: "2026-04-03", open: 10.6, close: 11.0, high: 11.2, low: 10.4, volume: 1_300_000, amount: 14_300_000 },
    { date: "2026-04-04", open: 11.0, close: 11.4, high: 11.5, low: 10.9, volume: 1_400_000, amount: 15_960_000 },
  ];

  const result = evaluatePeriod({
    universe: [
      { code: "00788", name: "ChinaTower", market: "港股通", relevance: "核心", concepts: "通信基建" },
      { code: "000002", name: "Normal", market: "深主板", relevance: "核心", concepts: "通信基建" },
    ],
    klineByCode: new Map([
      ["00788", pollutedCorporateActionKline],
      ["000002", normalKline],
    ]),
    asOf: "2026-04-02",
    end: "2026-04-04",
    topN: 2,
    params: {
      momentumWeight: 0.55,
      liquidityWeight: 0.15,
      stabilityWeight: 0.15,
      themeWeight: 0.15,
      minHistoryDays: 2,
    },
  });

  assert.deepEqual(result.top.map((row) => row.code), ["000002"]);
  const skipped = result.skipped.find((row) => row.code === "00788");
  assert.equal(skipped?.reason, "extreme_forward_return");
  assert.ok(skipped.forwardReturn > 5);
  assert.equal(skipped.entryDate, "2026-04-02");
  assert.equal(skipped.exitDate, "2026-04-04");
});

test("evaluatePeriod skips limit-up entries when tradability constraints are enabled", () => {
  const limitUpKline = [
    { date: "2026-04-01", open: 9.8, close: 10.0, high: 10.1, low: 9.7, volume: 1_000_000, amount: 10_000_000 },
    { date: "2026-04-02", open: 10.8, close: 11.0, high: 11.0, low: 10.7, volume: 1_200_000, amount: 13_200_000 },
    { date: "2026-04-03", open: 11.2, close: 11.8, high: 12.0, low: 11.0, volume: 1_100_000, amount: 12_980_000 },
  ];
  const normalKline = [
    { date: "2026-04-01", open: 9.8, close: 10.0, high: 10.1, low: 9.7, volume: 1_000_000, amount: 10_000_000 },
    { date: "2026-04-02", open: 10.2, close: 10.4, high: 10.6, low: 10.1, volume: 1_200_000, amount: 12_480_000 },
    { date: "2026-04-03", open: 10.5, close: 11.0, high: 11.1, low: 10.4, volume: 1_100_000, amount: 12_100_000 },
  ];
  const result = evaluatePeriod({
    universe: [
      { code: "000001", name: "LimitUp", market: "深主板", relevance: "核心", concepts: "机器人概念" },
      { code: "000002", name: "Tradable", market: "深主板", relevance: "核心", concepts: "机器人概念" },
    ],
    klineByCode: new Map([
      ["000001", limitUpKline],
      ["000002", normalKline],
    ]),
    asOf: "2026-04-02",
    end: "2026-04-03",
    topN: 1,
    params: {
      momentumWeight: 0.55,
      liquidityWeight: 0.15,
      stabilityWeight: 0.15,
      themeWeight: 0.15,
      minHistoryDays: 2,
      tradability: { enabled: true },
    },
  });

  assert.equal(result.top[0].code, "000002");
  assert.ok(result.skipped.some((row) => row.code === "000001" && row.reason === "entry_limit_up_like"));
});

test("evaluatePeriod delays exit when target end date is limit-down locked", () => {
  const kline = [
    { date: "2026-04-01", open: 9.7, close: 9.8, high: 10.0, low: 9.6, volume: 1_000_000, amount: 9_800_000 },
    { date: "2026-04-02", open: 9.9, close: 10.0, high: 10.1, low: 9.8, volume: 1_200_000, amount: 12_000_000 },
    { date: "2026-04-03", open: 9.0, close: 9.0, high: 9.05, low: 9.0, volume: 1_300_000, amount: 11_700_000 },
    { date: "2026-04-04", open: 8.7, close: 8.5, high: 8.8, low: 8.4, volume: 1_400_000, amount: 11_900_000 },
  ];
  const result = evaluatePeriod({
    universe: [
      { code: "000001", name: "LimitDownExit", market: "深主板", relevance: "核心", concepts: "机器人概念" },
    ],
    klineByCode: new Map([["000001", kline]]),
    asOf: "2026-04-02",
    end: "2026-04-03",
    topN: 1,
    params: {
      momentumWeight: 0.55,
      liquidityWeight: 0.15,
      stabilityWeight: 0.15,
      themeWeight: 0.15,
      minHistoryDays: 2,
      tradability: { enabled: true, maxExitDelayDays: 2 },
    },
  });

  assert.equal(result.top[0].exitDate, "2026-04-04");
  assert.equal(result.top[0].exitDelayDays, 1);
  assert.equal(result.top[0].exitReason, "exit_limit_down_like");
  assert.equal(Number(result.top[0].forwardReturn.toFixed(6)), -0.15);
});

test("evaluatePeriod applies point-in-time dynamic universe liquidity filters before ranking", () => {
  const lowLiquidityMomentum = [
    { date: "2026-04-01", open: 9.8, close: 10.0, high: 10.2, low: 9.7, volume: 1_000, amount: 10_000 },
    { date: "2026-04-02", open: 11.7, close: 12.0, high: 12.2, low: 11.6, volume: 1_000, amount: 12_000 },
    { date: "2026-04-03", open: 13.8, close: 14.0, high: 14.1, low: 13.7, volume: 1_000, amount: 14_000 },
  ];
  const liquidModerate = [
    { date: "2026-04-01", open: 9.8, close: 10.0, high: 10.2, low: 9.7, volume: 10_000_000, amount: 100_000_000 },
    { date: "2026-04-02", open: 10.0, close: 10.1, high: 10.2, low: 9.9, volume: 10_000_000, amount: 101_000_000 },
    { date: "2026-04-03", open: 10.1, close: 10.2, high: 10.3, low: 10.0, volume: 10_000_000, amount: 102_000_000 },
  ];
  const result = evaluatePeriod({
    universe: [
      { code: "000001", name: "LowLiquidityMomentum", market: "深主板", relevance: "核心", concepts: "机器人概念" },
      { code: "000002", name: "LiquidModerate", market: "深主板", relevance: "核心", concepts: "机器人概念" },
    ],
    klineByCode: new Map([
      ["000001", lowLiquidityMomentum],
      ["000002", liquidModerate],
    ]),
    asOf: "2026-04-02",
    end: "2026-04-03",
    topN: 1,
    params: {
      momentumWeight: 1,
      liquidityWeight: 0,
      stabilityWeight: 0,
      themeWeight: 0,
      minHistoryDays: 2,
      universeFilter: { enabled: true, minAvgTurnover20: 20_000_000 },
    },
  });

  assert.equal(result.top[0].code, "000002");
  assert.ok(result.skipped.some((row) => row.code === "000001" && row.reason === "universe_low_avg_turnover"));
});

test("evaluatePeriod applies asOf dynamic industry-strength filters after group metrics", () => {
  const strongCloses = [10.0, 10.8, 11.6, 12.4, 13.0, 13.3, 13.6];
  const weakCloses = [10.0, 9.9, 9.8, 9.7, 9.6, 9.7, 9.8];
  const universe = [
    { code: "000101", name: "StrongA", market: "深主板", industry: "电力出海" },
    { code: "000102", name: "StrongB", market: "深主板", industry: "电力出海" },
    { code: "000103", name: "StrongC", market: "深主板", industry: "电力出海" },
    { code: "000201", name: "WeakA", market: "深主板", industry: "弱主题", relevance: "核心", source: "manual_core_supplement", concepts: "a|b|c|d|e|f|g" },
    { code: "000202", name: "WeakB", market: "深主板", industry: "弱主题", relevance: "核心", source: "manual_core_supplement", concepts: "a|b|c|d|e|f|g" },
    { code: "000203", name: "WeakC", market: "深主板", industry: "弱主题", relevance: "核心", source: "manual_core_supplement", concepts: "a|b|c|d|e|f|g" },
  ];
  const klineByCode = new Map(universe.map((row) => [
    row.code,
    makePatternKline("2026-03-01", row.industry === "电力出海" ? strongCloses : weakCloses),
  ]));
  const baseParams = {
    momentumWeight: 0,
    liquidityWeight: 0,
    stabilityWeight: 0,
    themeWeight: 1,
    minHistoryDays: 5,
    industryMinGroupSize: 3,
  };

  const unfiltered = evaluatePeriod({
    universe,
    klineByCode,
    asOf: "2026-03-05",
    end: "2026-03-07",
    topN: 1,
    params: baseParams,
  });
  const filtered = evaluatePeriod({
    universe,
    klineByCode,
    asOf: "2026-03-05",
    end: "2026-03-07",
    topN: 3,
    params: {
      ...baseParams,
      universeFilter: {
        enabled: true,
        dynamicGroup: {
          enabled: true,
          groupBy: "industry",
          minGroupSize: 3,
          minGroupScore: 55,
          minBreadth20: 0.5,
        },
      },
    },
  });

  assert.equal(unfiltered.top[0].industry, "弱主题");
  assert.deepEqual(filtered.top.map((row) => row.industry), ["电力出海", "电力出海", "电力出海"]);
  assert.ok(filtered.top.every((row) => row.dynamicGroupKey === "industry:电力出海"));
  assert.ok(filtered.top.every((row) => row.dynamicGroupScore >= 55));
  assert.equal(filtered.skipped.filter((row) => row.reason === "universe_weak_dynamic_group").length, 3);
});

test("dynamic industry-strength filters do not change when only future returns change", () => {
  const strongHistory = [10.0, 10.8, 11.6, 12.4, 13.0];
  const weakHistory = [10.0, 9.9, 9.8, 9.7, 9.6];
  const universe = [
    { code: "000101", name: "StrongA", market: "深主板", industry: "电力出海" },
    { code: "000102", name: "StrongB", market: "深主板", industry: "电力出海" },
    { code: "000103", name: "StrongC", market: "深主板", industry: "电力出海" },
    { code: "000201", name: "WeakA", market: "深主板", industry: "弱主题", relevance: "核心", source: "manual_core_supplement", concepts: "a|b|c|d|e|f|g" },
    { code: "000202", name: "WeakB", market: "深主板", industry: "弱主题", relevance: "核心", source: "manual_core_supplement", concepts: "a|b|c|d|e|f|g" },
    { code: "000203", name: "WeakC", market: "深主板", industry: "弱主题", relevance: "核心", source: "manual_core_supplement", concepts: "a|b|c|d|e|f|g" },
  ];
  const buildMap = (strongFuture, weakFuture) => new Map(universe.map((row) => [
    row.code,
    makePatternKline(
      "2026-03-01",
      row.industry === "电力出海"
        ? strongHistory.concat(strongFuture)
        : weakHistory.concat(weakFuture)
    ),
  ]));
  const params = {
    momentumWeight: 0,
    liquidityWeight: 0,
    stabilityWeight: 0,
    themeWeight: 1,
    minHistoryDays: 5,
    industryMinGroupSize: 3,
    universeFilter: {
      enabled: true,
      dynamicGroup: {
        enabled: true,
        groupBy: "industry",
        minGroupSize: 3,
        minGroupScore: 55,
        minBreadth20: 0.5,
      },
    },
  };

  const strongFutureWins = evaluatePeriod({
    universe,
    klineByCode: buildMap([13.4, 13.9], [9.4, 9.3]),
    asOf: "2026-03-05",
    end: "2026-03-07",
    topN: 3,
    params,
  });
  const weakFutureWins = evaluatePeriod({
    universe,
    klineByCode: buildMap([12.6, 12.2], [10.5, 11.4]),
    asOf: "2026-03-05",
    end: "2026-03-07",
    topN: 3,
    params,
  });

  assert.deepEqual(strongFutureWins.scored.map((row) => row.code), weakFutureWins.scored.map((row) => row.code));
  assert.equal(strongFutureWins.skipped.filter((row) => row.reason === "universe_weak_dynamic_group").length, 3);
  assert.equal(weakFutureWins.skipped.filter((row) => row.reason === "universe_weak_dynamic_group").length, 3);
  assert.deepEqual(
    strongFutureWins.skipped.filter((row) => row.reason === "universe_weak_dynamic_group").map((row) => row.code).sort(),
    weakFutureWins.skipped.filter((row) => row.reason === "universe_weak_dynamic_group").map((row) => row.code).sort()
  );
});

test("dynamic industry-strength filters fail open when remaining pool is below the coverage floor", () => {
  const strongCloses = [10.0, 10.8, 11.6, 12.4, 13.0, 13.3, 13.6];
  const weakCloses = [10.0, 9.9, 9.8, 9.7, 9.6, 9.7, 9.8];
  const universe = [
    { code: "000101", name: "StrongA", market: "深主板", industry: "电力出海" },
    { code: "000102", name: "StrongB", market: "深主板", industry: "电力出海" },
    { code: "000103", name: "StrongC", market: "深主板", industry: "电力出海" },
    { code: "000201", name: "WeakA", market: "深主板", industry: "弱主题", relevance: "核心", source: "manual_core_supplement", concepts: "a|b|c|d|e|f|g" },
    { code: "000202", name: "WeakB", market: "深主板", industry: "弱主题", relevance: "核心", source: "manual_core_supplement", concepts: "a|b|c|d|e|f|g" },
    { code: "000203", name: "WeakC", market: "深主板", industry: "弱主题", relevance: "核心", source: "manual_core_supplement", concepts: "a|b|c|d|e|f|g" },
  ];
  const klineByCode = new Map(universe.map((row) => [
    row.code,
    makePatternKline("2026-03-01", row.industry === "电力出海" ? strongCloses : weakCloses),
  ]));

  const filtered = evaluatePeriod({
    universe,
    klineByCode,
    asOf: "2026-03-05",
    end: "2026-03-07",
    topN: 3,
    params: {
      momentumWeight: 0,
      liquidityWeight: 0,
      stabilityWeight: 0,
      themeWeight: 1,
      minHistoryDays: 5,
      industryMinGroupSize: 3,
      universeFilter: {
        enabled: true,
        dynamicGroup: {
          enabled: true,
          groupBy: "industry",
          minGroupSize: 3,
          minGroupScore: 55,
          minBreadth20: 0.5,
          minRemainingCount: 4,
        },
      },
    },
  });

  assert.equal(filtered.scored.length, 6);
  assert.equal(filtered.skipped.filter((row) => row.reason === "universe_weak_dynamic_group").length, 0);
  assert.equal(filtered.top[0].industry, "弱主题");
});

test("dynamic industry-strength filters fail open when remaining pool is below a coverage ratio", () => {
  const strongCloses = [10.0, 10.8, 11.6, 12.4, 13.0, 13.3, 13.6];
  const weakCloses = [10.0, 9.9, 9.8, 9.7, 9.6, 9.7, 9.8];
  const universe = [
    { code: "000101", name: "StrongA", market: "深主板", industry: "电力出海" },
    { code: "000102", name: "StrongB", market: "深主板", industry: "电力出海" },
    { code: "000103", name: "StrongC", market: "深主板", industry: "电力出海" },
    { code: "000201", name: "WeakA", market: "深主板", industry: "弱主题", relevance: "核心", source: "manual_core_supplement", concepts: "a|b|c|d|e|f|g" },
    { code: "000202", name: "WeakB", market: "深主板", industry: "弱主题", relevance: "核心", source: "manual_core_supplement", concepts: "a|b|c|d|e|f|g" },
    { code: "000203", name: "WeakC", market: "深主板", industry: "弱主题", relevance: "核心", source: "manual_core_supplement", concepts: "a|b|c|d|e|f|g" },
  ];
  const klineByCode = new Map(universe.map((row) => [
    row.code,
    makePatternKline("2026-03-01", row.industry === "电力出海" ? strongCloses : weakCloses),
  ]));

  const filtered = evaluatePeriod({
    universe,
    klineByCode,
    asOf: "2026-03-05",
    end: "2026-03-07",
    topN: 3,
    params: {
      momentumWeight: 0,
      liquidityWeight: 0,
      stabilityWeight: 0,
      themeWeight: 1,
      minHistoryDays: 5,
      industryMinGroupSize: 3,
      universeFilter: {
        enabled: true,
        dynamicGroup: {
          enabled: true,
          groupBy: "industry",
          minGroupSize: 3,
          minGroupScore: 55,
          minBreadth20: 0.5,
          minRemainingRatio: 0.7,
        },
      },
    },
  });

  assert.equal(filtered.scored.length, 6);
  assert.equal(filtered.skipped.filter((row) => row.reason === "universe_weak_dynamic_group").length, 0);
  assert.equal(filtered.top[0].industry, "弱主题");
});

test("welchTTest reports a small p-value when top returns dominate broad universe returns", () => {
  const stats = welchTTest([0.30, 0.28, 0.33, 0.27, 0.31], [0.01, -0.02, 0.03, 0.00, 0.02, -0.01]);
  assert.ok(stats.t > 5);
  assert.ok(stats.pValue < 0.01);
});

test("marketSymbol normalizes A-share and HK-share prefixes", () => {
  assert.equal(marketSymbol({ code: "300476", market: "创业板" }), "sz300476");
  assert.equal(marketSymbol({ code: "688322", market: "科创板" }), "sh688322");
  assert.equal(marketSymbol({ code: "920002", market: "北交所/新三板系" }), "bj920002");
  assert.equal(marketSymbol({ code: "1810", market: "港股通" }), "hk01810");
  assert.equal(marketSymbol({ code: "09926", market: "港股通" }), "hk09926");
});

test("benchmarkReturn computes index return without affecting score-time slicing", () => {
  const kline = makeKline(100, -2, 3);
  assert.equal(
    Number(benchmarkReturn(kline, "2026-04-04", "2026-04-08").toFixed(6)),
    Number((((100 - 2 * 4 + 3 * 4) / (100 - 2 * 4)) - 1).toFixed(6))
  );
});

test("applyCrossSectionalRankScore rewards risk-adjusted ranks and ignores future returns", () => {
  const rows = [
    {
      code: "000001",
      name: "CleanTrend",
      score: 64,
      r5: 0.03,
      r20: 0.12,
      r60: 0.26,
      dd60: -0.05,
      vol20: 0.28,
      avgTurnover20: 900000000,
      themeScore: 70,
      forwardReturn: -0.40,
    },
    {
      code: "000002",
      name: "Overheated",
      score: 98,
      r5: 0.28,
      r20: 0.62,
      r60: 0.74,
      dd60: -0.02,
      vol20: 1.75,
      avgTurnover20: 1200000000,
      themeScore: 92,
      forwardReturn: 0.80,
    },
    {
      code: "000003",
      name: "WeakTrend",
      score: 58,
      r5: -0.04,
      r20: -0.06,
      r60: 0.02,
      dd60: -0.22,
      vol20: 0.62,
      avgTurnover20: 140000000,
      themeScore: 55,
      forwardReturn: 0.20,
    },
  ];
  const params = {
    rankMomentumWeight: 0.30,
    rankStabilityWeight: 0.42,
    rankLiquidityWeight: 0.16,
    rankThemeWeight: 0.04,
    rankConsistencyWeight: 0.08,
    rankRawScoreWeight: 0,
    rankOverheatPenalty: 24,
  };
  const first = applyCrossSectionalRankScore(rows.map((row) => ({ ...row })), params);
  const second = applyCrossSectionalRankScore(rows.map((row) => ({ ...row, forwardReturn: row.forwardReturn * -3 })), params);

  const clean = first.find((row) => row.code === "000001");
  const overheated = first.find((row) => row.code === "000002");
  const weak = first.find((row) => row.code === "000003");
  assert.ok(clean.score > overheated.score, `expected clean trend to beat overheated move: ${clean.score} vs ${overheated.score}`);
  assert.ok(clean.score > weak.score, `expected clean trend to beat weak trend: ${clean.score} vs ${weak.score}`);
  assert.deepEqual(
    first.map((row) => row.score),
    second.map((row) => row.score),
    "rank score must not use forward returns"
  );
});

test("applyCrossSectionalRankScore can reward benchmark trend state without using future returns", () => {
  const rows = [
    {
      code: "000001",
      name: "StrongBenchmarkState",
      score: 70,
      r5: 0.03,
      r20: 0.12,
      r60: 0.24,
      dd60: -0.06,
      vol20: 0.35,
      avgTurnover20: 500000000,
      themeScore: 70,
      benchmarkR60: 0.30,
      relativeMomentumScore: 74,
      forwardReturn: -0.30,
    },
    {
      code: "000002",
      name: "WeakBenchmarkState",
      score: 70,
      r5: 0.03,
      r20: 0.12,
      r60: 0.24,
      dd60: -0.06,
      vol20: 0.35,
      avgTurnover20: 500000000,
      themeScore: 70,
      benchmarkR60: -0.10,
      relativeMomentumScore: 40,
      forwardReturn: 0.80,
    },
  ];
  const params = {
    rankMomentumWeight: 0,
    rankStabilityWeight: 0,
    rankLiquidityWeight: 0,
    rankThemeWeight: 0,
    rankConsistencyWeight: 0,
    rankBenchmarkTrendWeight: 0.55,
    rankRelativeMomentumWeight: 0.45,
    rankRawScoreWeight: 0,
    rankOverheatPenalty: 0,
  };
  const first = applyCrossSectionalRankScore(rows.map((row) => ({ ...row })), params);
  const second = applyCrossSectionalRankScore(rows.map((row) => ({ ...row, forwardReturn: row.forwardReturn * -2 })), params);

  const strong = first.find((row) => row.code === "000001");
  const weak = first.find((row) => row.code === "000002");
  assert.ok(strong.score > weak.score, `expected benchmark-state rank to prefer strong market state: ${strong.score} vs ${weak.score}`);
  assert.ok(strong.benchmarkTrendRankScore > weak.benchmarkTrendRankScore);
  assert.ok(strong.relativeMomentumRankScore > weak.relativeMomentumRankScore);
  assert.deepEqual(
    first.map((row) => row.score),
    second.map((row) => row.score),
    "benchmark-state rank score must not use forward returns"
  );
});

test("applyCrossSectionalRankScore can reward dynamic group strength without using future returns", () => {
  const rows = [
    {
      code: "000001",
      name: "StrongConcept",
      score: 70,
      r5: 0.03,
      r20: 0.12,
      r60: 0.24,
      dd60: -0.06,
      vol20: 0.35,
      avgTurnover20: 500000000,
      themeScore: 70,
      dynamicGroupScore: 78,
      forwardReturn: -0.30,
    },
    {
      code: "000002",
      name: "WeakConcept",
      score: 70,
      r5: 0.03,
      r20: 0.12,
      r60: 0.24,
      dd60: -0.06,
      vol20: 0.35,
      avgTurnover20: 500000000,
      themeScore: 70,
      dynamicGroupScore: 42,
      forwardReturn: 0.80,
    },
  ];
  const params = {
    rankMomentumWeight: 0,
    rankStabilityWeight: 0,
    rankLiquidityWeight: 0,
    rankThemeWeight: 0,
    rankConsistencyWeight: 0,
    rankDynamicGroupWeight: 1,
    rankRawScoreWeight: 0,
    rankOverheatPenalty: 0,
  };
  const first = applyCrossSectionalRankScore(rows.map((row) => ({ ...row })), params);
  const second = applyCrossSectionalRankScore(rows.map((row) => ({ ...row, forwardReturn: row.forwardReturn * -2 })), params);

  const strong = first.find((row) => row.code === "000001");
  const weak = first.find((row) => row.code === "000002");
  assert.ok(strong.score > weak.score, `expected dynamic group rank to prefer stronger concept: ${strong.score} vs ${weak.score}`);
  assert.ok(strong.dynamicGroupRankScore > weak.dynamicGroupRankScore);
  assert.deepEqual(
    first.map((row) => row.score),
    second.map((row) => row.score),
    "dynamic-group rank score must not use forward returns"
  );
});

test("evaluatePeriod applies dynamic concept metrics for ranking without filtering the pool", () => {
  const strongCloses = [10.0, 10.5, 10.9, 11.4, 11.8, 12.2, 12.6];
  const weakCloses = [10.0, 9.95, 9.9, 9.85, 9.8, 9.85, 9.9];
  const universe = [
    { code: "000101", name: "StrongA", market: "深主板", industry: "设备", concepts: "强概念|机器人" },
    { code: "000102", name: "StrongB", market: "深主板", industry: "设备", concepts: "强概念|传感器" },
    { code: "000103", name: "StrongC", market: "深主板", industry: "设备", concepts: "强概念|AI终端" },
    { code: "000201", name: "WeakA", market: "深主板", industry: "设备", concepts: "弱概念|机器人" },
    { code: "000202", name: "WeakB", market: "深主板", industry: "设备", concepts: "弱概念|传感器" },
    { code: "000203", name: "WeakC", market: "深主板", industry: "设备", concepts: "弱概念|AI终端" },
  ];
  const klineByCode = new Map(universe.map((row) => [
    row.code,
    makePatternKline("2026-03-01", row.concepts.includes("强概念") ? strongCloses : weakCloses),
  ]));

  const result = evaluatePeriod({
    universe,
    klineByCode,
    asOf: "2026-03-05",
    end: "2026-03-07",
    topN: 3,
    params: {
      momentumWeight: 0,
      liquidityWeight: 0,
      stabilityWeight: 0,
      themeWeight: 1,
      minHistoryDays: 5,
      industryMinGroupSize: 3,
      dynamicGroupMetrics: {
        enabled: true,
        groupBy: "concept",
        minGroupSize: 3,
      },
      rankBlend: true,
      rankMomentumWeight: 0,
      rankStabilityWeight: 0,
      rankLiquidityWeight: 0,
      rankThemeWeight: 0,
      rankConsistencyWeight: 0,
      rankDynamicGroupWeight: 1,
      rankRawScoreWeight: 0,
      rankOverheatPenalty: 0,
    },
  });

  assert.equal(result.scored.length, 6);
  assert.equal(result.skipped.filter((row) => row.reason === "universe_weak_dynamic_group").length, 0);
  assert.ok(result.top.every((row) => row.concepts.includes("强概念")));
  assert.ok(result.top.every((row) => row.dynamicGroupKey === "concept:强概念"));
  assert.ok(result.top.every((row) => Number.isFinite(row.dynamicGroupRankScore)));
});

test("evaluatePeriod can blend dynamic concept strength as a score tiebreaker without filtering the pool", () => {
  const strongCloses = [10.0, 10.5, 10.9, 11.4, 11.8, 12.2, 12.6];
  const weakCloses = [10.0, 9.95, 9.9, 9.85, 9.8, 9.85, 9.9];
  const universe = [
    { code: "000201", name: "WeakA", market: "深主板", industry: "设备", concepts: "弱概念|机器人" },
    { code: "000202", name: "WeakB", market: "深主板", industry: "设备", concepts: "弱概念|传感器" },
    { code: "000203", name: "WeakC", market: "深主板", industry: "设备", concepts: "弱概念|AI终端" },
    { code: "000101", name: "StrongA", market: "深主板", industry: "设备", concepts: "强概念|机器人" },
    { code: "000102", name: "StrongB", market: "深主板", industry: "设备", concepts: "强概念|传感器" },
    { code: "000103", name: "StrongC", market: "深主板", industry: "设备", concepts: "强概念|AI终端" },
  ];
  const klineByCode = new Map(universe.map((row) => [
    row.code,
    makePatternKline("2026-03-01", row.concepts.includes("强概念") ? strongCloses : weakCloses),
  ]));

  const result = evaluatePeriod({
    universe,
    klineByCode,
    asOf: "2026-03-05",
    end: "2026-03-07",
    topN: 3,
    params: {
      momentumWeight: 0,
      liquidityWeight: 0,
      stabilityWeight: 0,
      themeWeight: 1,
      minHistoryDays: 5,
      industryMinGroupSize: 3,
      dynamicGroupMetrics: {
        enabled: true,
        groupBy: "concept",
        minGroupSize: 3,
        scoreWeight: 0.20,
      },
    },
  });

  assert.equal(result.scored.length, 6);
  assert.equal(result.skipped.filter((row) => row.reason === "universe_weak_dynamic_group").length, 0);
  assert.ok(result.top.every((row) => row.concepts.includes("强概念")));
  assert.ok(result.top.every((row) => row.dynamicGroupKey === "concept:强概念"));
  assert.ok(result.top.every((row) => Number.isFinite(row.scoreBeforeDynamicGroupBlend)));
  assert.ok(result.top.every((row) => row.score > row.scoreBeforeDynamicGroupBlend));
});

test("evaluatePeriod can blend dynamic source strength as a score tiebreaker without filtering the pool", () => {
  const strongCloses = [10.0, 10.4, 10.8, 11.1, 11.5, 12.0, 12.4];
  const weakCloses = [10.0, 9.9, 9.85, 9.8, 9.78, 9.75, 9.72];
  const universe = [
    { code: "000301", name: "WeakSourceA", market: "深主板", industry: "设备", source: "generic_theme", universeSource: "theme_pool.csv" },
    { code: "000302", name: "WeakSourceB", market: "深主板", industry: "设备", source: "generic_theme", universeSource: "theme_pool.csv" },
    { code: "000303", name: "WeakSourceC", market: "深主板", industry: "设备", source: "generic_theme", universeSource: "theme_pool.csv" },
    { code: "000401", name: "StrongSourceA", market: "深主板", industry: "设备", source: "physical_ai_core", universeSource: "physical_ai_core_candidates.csv" },
    { code: "000402", name: "StrongSourceB", market: "深主板", industry: "设备", source: "physical_ai_core", universeSource: "physical_ai_core_candidates.csv" },
    { code: "000403", name: "StrongSourceC", market: "深主板", industry: "设备", source: "physical_ai_core", universeSource: "physical_ai_core_candidates.csv" },
  ];
  const klineByCode = new Map(universe.map((row) => [
    row.code,
    makePatternKline("2026-03-01", row.universeSource.includes("physical") ? strongCloses : weakCloses),
  ]));

  const result = evaluatePeriod({
    universe,
    klineByCode,
    asOf: "2026-03-05",
    end: "2026-03-07",
    topN: 3,
    params: {
      momentumWeight: 0,
      liquidityWeight: 0,
      stabilityWeight: 0,
      themeWeight: 1,
      minHistoryDays: 5,
      industryMinGroupSize: 3,
      dynamicGroupMetrics: {
        enabled: true,
        groupBy: "source",
        minGroupSize: 3,
        scoreWeight: 0.20,
      },
    },
  });

  assert.equal(result.scored.length, 6);
  assert.ok(result.top.every((row) => row.universeSource === "physical_ai_core_candidates.csv"));
  assert.ok(result.top.every((row) => row.dynamicGroupKey === "source:physical_ai_core_candidates.csv"));
  assert.ok(result.top.every((row) => Number.isFinite(row.scoreBeforeDynamicGroupBlend)));
  assert.ok(result.top.every((row) => row.score > row.scoreBeforeDynamicGroupBlend));
});

test("scoreAtDate rewards medium-trend short-term reversal with stable turnover using only pre-asOf data", () => {
  const constructivePullback = scoreAtDate(
    fixtureRows[0],
    makePatternKline(
      "2026-03-01",
      [10.0, 10.3, 10.6, 10.9, 11.2, 11.5, 11.8, 12.0, 11.85, 11.72, 11.68, 11.76],
      [1_000_000, 1_050_000, 980_000, 1_020_000, 1_030_000, 1_000_000, 1_060_000, 1_040_000, 990_000, 1_010_000, 970_000, 1_000_000]
    ),
    "2026-03-10",
    { momentumWeight: 0.34, liquidityWeight: 0.24, stabilityWeight: 0.24, themeWeight: 0.18, minHistoryDays: 8 }
  );
  const overheatedNoisy = scoreAtDate(
    fixtureRows[1],
    makePatternKline(
      "2026-03-01",
      [10.0, 10.1, 10.2, 10.35, 10.5, 10.8, 11.3, 12.2, 13.3, 14.6, 15.4, 16.0],
      [300_000, 3_000_000, 450_000, 4_000_000, 500_000, 6_500_000, 650_000, 8_000_000, 700_000, 9_500_000, 800_000, 11_000_000]
    ),
    "2026-03-10",
    { momentumWeight: 0.34, liquidityWeight: 0.24, stabilityWeight: 0.24, themeWeight: 0.18, minHistoryDays: 8 }
  );
  const futureChanged = scoreAtDate(
    fixtureRows[0],
    makePatternKline(
      "2026-03-01",
      [10.0, 10.3, 10.6, 10.9, 11.2, 11.5, 11.8, 12.0, 11.85, 11.72, 13.8, 15.0],
      [1_000_000, 1_050_000, 980_000, 1_020_000, 1_030_000, 1_000_000, 1_060_000, 1_040_000, 990_000, 1_010_000, 7_000_000, 8_000_000]
    ),
    "2026-03-10",
    { momentumWeight: 0.34, liquidityWeight: 0.24, stabilityWeight: 0.24, themeWeight: 0.18, minHistoryDays: 8 }
  );

  assert.ok(constructivePullback.shortTermReversalScore > overheatedNoisy.shortTermReversalScore);
  assert.ok(constructivePullback.turnoverStabilityScore > overheatedNoisy.turnoverStabilityScore);
  assert.equal(constructivePullback.shortTermReversalScore, futureChanged.shortTermReversalScore);
  assert.equal(constructivePullback.turnoverStabilityScore, futureChanged.turnoverStabilityScore);
});

test("scoreAtDate rewards fresh acceleration over stale long-trend extension using only pre-asOf data", () => {
  const freshAcceleration = makePatternKline(
    "2026-01-01",
    [
      ...Array.from({ length: 45 }, (_, i) => 10 + i * 0.003),
      ...Array.from({ length: 20 }, (_, i) => 10.2 + i * 0.075),
      11.75,
      11.86,
      11.98,
      12.12,
      12.25,
      12.35,
    ],
    Array.from({ length: 71 }, (_, i) => 1_000_000 + i * 5_000)
  );
  const staleExtension = makePatternKline(
    "2026-01-01",
    [
      ...Array.from({ length: 45 }, (_, i) => 10 + i * 0.13),
      ...Array.from({ length: 20 }, (_, i) => 15.85 - i * 0.015),
      15.50,
      15.42,
      15.34,
      15.28,
      15.20,
      15.12,
    ],
    Array.from({ length: 71 }, (_, i) => 1_000_000 + i * 5_000)
  );

  const params = {
    momentumWeight: 0.34,
    liquidityWeight: 0.24,
    stabilityWeight: 0.24,
    themeWeight: 0.18,
    freshTrendScoreWeight: 0.35,
    minHistoryDays: 65,
  };
  const fresh = scoreAtDate(fixtureRows[0], freshAcceleration, "2026-03-11", params);
  const stale = scoreAtDate(fixtureRows[1], staleExtension, "2026-03-11", params);
  const futureChanged = scoreAtDate(
    fixtureRows[0],
    freshAcceleration.concat(makePatternKline("2026-03-13", [20, 22, 25], [8_000_000, 8_500_000, 9_000_000])),
    "2026-03-11",
    params
  );

  assert.equal(fresh.status, "scored");
  assert.equal(stale.status, "scored");
  assert.ok(fresh.freshTrendScore > stale.freshTrendScore + 20);
  assert.ok(fresh.score > stale.score);
  assert.equal(fresh.freshTrendScore, futureChanged.freshTrendScore);
  assert.equal(fresh.trendMaturityPenaltyScore, futureChanged.trendMaturityPenaltyScore);
});

test("scoreAtDate penalizes one-day lottery spikes using only pre-asOf daily returns", () => {
  const smoothTrend = scoreAtDate(
    fixtureRows[0],
    makePatternKline(
      "2026-03-01",
      [10.0, 10.18, 10.34, 10.53, 10.72, 10.94, 11.16, 11.39, 11.62, 11.86, 12.10, 12.35],
      [1_000_000, 1_050_000, 1_020_000, 1_080_000, 1_040_000, 1_090_000, 1_060_000, 1_100_000, 1_070_000, 1_120_000, 1_080_000, 1_130_000]
    ),
    "2026-03-10",
    { momentumWeight: 0.34, liquidityWeight: 0.24, stabilityWeight: 0.24, themeWeight: 0.18, minHistoryDays: 8 }
  );
  const lotterySpike = scoreAtDate(
    fixtureRows[1],
    makePatternKline(
      "2026-03-01",
      [10.0, 10.12, 10.18, 10.25, 12.30, 12.38, 12.45, 12.52, 12.62, 12.69, 12.76, 12.84],
      [1_000_000, 1_020_000, 1_030_000, 1_040_000, 7_000_000, 1_010_000, 1_020_000, 1_030_000, 1_020_000, 1_010_000, 1_020_000, 1_030_000]
    ),
    "2026-03-10",
    { momentumWeight: 0.34, liquidityWeight: 0.24, stabilityWeight: 0.24, themeWeight: 0.18, minHistoryDays: 8 }
  );
  const futureChanged = scoreAtDate(
    fixtureRows[1],
    makePatternKline(
      "2026-03-01",
      [10.0, 10.12, 10.18, 10.25, 12.30, 12.38, 12.45, 12.52, 12.62, 12.69, 15.80, 16.80],
      [1_000_000, 1_020_000, 1_030_000, 1_040_000, 7_000_000, 1_010_000, 1_020_000, 1_030_000, 1_020_000, 1_010_000, 9_000_000, 10_000_000]
    ),
    "2026-03-10",
    { momentumWeight: 0.34, liquidityWeight: 0.24, stabilityWeight: 0.24, themeWeight: 0.18, minHistoryDays: 8 }
  );

  assert.ok(lotterySpike.maxDailyReturn20 > smoothTrend.maxDailyReturn20);
  assert.ok(smoothTrend.lotterySpikeScore > lotterySpike.lotterySpikeScore);
  assert.equal(futureChanged.maxDailyReturn20, lotterySpike.maxDailyReturn20);
  assert.equal(futureChanged.lotterySpikeScore, lotterySpike.lotterySpikeScore);
});

test("applyCrossSectionalRankScore can reward reversal-stability ranks without using future returns", () => {
  const rows = [
    {
      code: "000001",
      name: "StablePullback",
      score: 70,
      r5: -0.02,
      r20: 0.12,
      r60: 0.24,
      dd60: -0.08,
      vol20: 0.35,
      avgTurnover20: 500000000,
      themeScore: 70,
      shortTermReversalScore: 78,
      turnoverStabilityScore: 82,
      forwardReturn: -0.30,
    },
    {
      code: "000002",
      name: "NoisyOverheat",
      score: 70,
      r5: 0.18,
      r20: 0.28,
      r60: 0.35,
      dd60: -0.03,
      vol20: 1.15,
      avgTurnover20: 500000000,
      themeScore: 70,
      shortTermReversalScore: 34,
      turnoverStabilityScore: 25,
      forwardReturn: 0.80,
    },
  ];
  const params = {
    rankMomentumWeight: 0,
    rankStabilityWeight: 0,
    rankLiquidityWeight: 0,
    rankThemeWeight: 0,
    rankConsistencyWeight: 0,
    rankShortTermReversalWeight: 0.65,
    rankTurnoverStabilityWeight: 0.35,
    rankRawScoreWeight: 0,
    rankOverheatPenalty: 0,
  };
  const first = applyCrossSectionalRankScore(rows.map((row) => ({ ...row })), params);
  const second = applyCrossSectionalRankScore(rows.map((row) => ({ ...row, forwardReturn: row.forwardReturn * -2 })), params);

  const stable = first.find((row) => row.code === "000001");
  const noisy = first.find((row) => row.code === "000002");
  assert.ok(stable.score > noisy.score, `expected reversal-stability rank to prefer stable pullback: ${stable.score} vs ${noisy.score}`);
  assert.ok(stable.shortTermReversalRankScore > noisy.shortTermReversalRankScore);
  assert.ok(stable.turnoverStabilityRankScore > noisy.turnoverStabilityRankScore);
  assert.deepEqual(
    first.map((row) => row.score),
    second.map((row) => row.score),
    "reversal-stability rank score must not use forward returns"
  );
});

test("applyCrossSectionalRankScore can reward fresh-trend ranks without using future returns", () => {
  const rows = [
    {
      code: "000001",
      name: "FreshAcceleration",
      score: 68,
      r5: 0.04,
      r20: 0.16,
      r60: 0.20,
      acceleration20vs60: 0.093,
      dd60: -0.07,
      vol20: 0.42,
      avgTurnover20: 300000000,
      themeScore: 65,
      freshTrendScore: 86,
      trendMaturityPenaltyScore: 4,
      forwardReturn: -0.25,
    },
    {
      code: "000002",
      name: "StaleExtension",
      score: 68,
      r5: -0.03,
      r20: -0.01,
      r60: 0.62,
      acceleration20vs60: -0.217,
      dd60: -0.04,
      vol20: 0.40,
      avgTurnover20: 300000000,
      themeScore: 65,
      freshTrendScore: 28,
      trendMaturityPenaltyScore: 74,
      forwardReturn: 0.90,
    },
  ];
  const params = {
    rankMomentumWeight: 0,
    rankStabilityWeight: 0,
    rankLiquidityWeight: 0,
    rankThemeWeight: 0,
    rankConsistencyWeight: 0,
    rankFreshTrendWeight: 1,
    rankRawScoreWeight: 0,
    rankOverheatPenalty: 0,
  };
  const first = applyCrossSectionalRankScore(rows.map((row) => ({ ...row })), params).sort((a, b) => b.score - a.score);
  const second = applyCrossSectionalRankScore(rows.map((row) => ({ ...row, forwardReturn: row.forwardReturn * -2 })), params)
    .sort((a, b) => b.score - a.score);

  assert.equal(first[0].code, "000001");
  assert.ok(first[0].freshTrendRankScore > first[1].freshTrendRankScore);
  assert.deepEqual(
    first.map((row) => row.score),
    second.map((row) => row.score),
    "fresh-trend rank score must not use forward returns"
  );
});

test("applyCrossSectionalRankScore can penalize high lottery-spike ranks without using future returns", () => {
  const rows = [
    {
      code: "000001",
      name: "SmoothTrend",
      score: 70,
      r5: 0.05,
      r20: 0.22,
      r60: 0.34,
      dd60: -0.04,
      vol20: 0.35,
      avgTurnover20: 500_000_000,
      themeScore: 70,
      lotterySpikeScore: 86,
      forwardReturn: -0.50,
    },
    {
      code: "000002",
      name: "OneDaySpike",
      score: 70,
      r5: 0.05,
      r20: 0.22,
      r60: 0.34,
      dd60: -0.04,
      vol20: 0.35,
      avgTurnover20: 500_000_000,
      themeScore: 70,
      lotterySpikeScore: 25,
      forwardReturn: 0.80,
    },
  ];
  const params = {
    rankMomentumWeight: 0,
    rankStabilityWeight: 0,
    rankLiquidityWeight: 0,
    rankThemeWeight: 0,
    rankConsistencyWeight: 0,
    rankRawScoreWeight: 0,
    rankLotterySpikeWeight: 1,
    rankOverheatPenalty: 0,
  };
  const first = applyCrossSectionalRankScore(rows.map((row) => ({ ...row })), params).sort((a, b) => b.score - a.score);
  const second = applyCrossSectionalRankScore(rows.map((row) => ({ ...row, forwardReturn: row.forwardReturn * -2 })), params)
    .sort((a, b) => b.score - a.score);

  assert.equal(first[0].code, "000001");
  assert.ok(first[0].lotterySpikeRankScore > first[1].lotterySpikeRankScore);
  assert.deepEqual(
    first.map((row) => row.score),
    second.map((row) => row.score),
    "lottery-spike rank score must not use forward returns"
  );
});

test("paramGrid keeps legacy params and adds rank-based candidates", () => {
  const names = paramGrid().map((params) => params.name);
  assert.ok(names.includes("breakout_v3"));
  assert.ok(names.includes("rank_momentum_risk_v6"));
  assert.ok(names.includes("rank_balanced_alpha_v8"));
  assert.ok(paramGrid().some((params) => params.rankBlend));
});

test("defaultParams tracks the validated balanced baseline for unoptimized scoring", () => {
  const defaults = defaultParams();
  const balanced = paramGrid().find((params) => params.name === "balanced_v2");

  assert.ok(balanced);
  assert.equal(defaults.name, "balanced_v2");
  for (const key of ["momentumWeight", "liquidityWeight", "stabilityWeight", "themeWeight", "minHistoryDays"]) {
    assert.equal(defaults[key], balanced[key], `${key} should match balanced_v2`);
  }
});

test("paramGrid includes acceleration-relative hybrids for theme breakout resilience", () => {
  const params = paramGrid();
  const hybrid = params.find((item) => item.name === "rank_acceleration_theme_hybrid_v18");
  const overlay = params.find((item) => item.name === "rank_acceleration_theme_attack_overlay_v21");

  assert.ok(hybrid);
  assert.ok(hybrid.rankBlend);
  assert.ok(hybrid.rankAccelerationWeight > 0.10);
  assert.ok(hybrid.rankRelativeWeight > 0.20);
  assert.ok(hybrid.rankThemeWeight >= 0.06);
  assert.ok(hybrid.rankStabilityWeight >= 0.12);
  assert.ok(overlay?.benchmarkOverlay?.enabled);
  assert.ok(overlay.benchmarkOverlay.trigger20 < 0.08);
});

test("paramGrid includes tradability-aware acceleration candidates", () => {
  const params = paramGrid();
  const balanced = params.find((item) => item.name === "rank_tradable_acceleration_balanced_v22");
  const recovery = params.find((item) => item.name === "rank_tradable_relative_recovery_v23");
  const liquid = params.find((item) => item.name === "rank_tradable_liquid_attack_v24");

  assert.ok(balanced);
  assert.ok(recovery);
  assert.ok(liquid);
  assert.ok(balanced.rankAccelerationWeight > 0.08);
  assert.ok(balanced.rankAccelerationWeight < 0.20);
  assert.ok(balanced.rankRelativeWeight >= 0.28);
  assert.ok(recovery.rankStabilityWeight >= 0.16);
  assert.ok(liquid.rankLiquidityWeight >= 0.14);
  assert.ok(liquid.weighting.maxWeight <= 0.16);
});

test("paramGrid includes pullback-accumulation candidates", () => {
  const params = paramGrid();
  const balanced = params.find((item) => item.name === "rank_pullback_accumulation_v25");
  const relative = params.find((item) => item.name === "rank_pullback_relative_v26");
  const attack = params.find((item) => item.name === "rank_pullback_attack_v27");

  assert.ok(balanced);
  assert.ok(relative);
  assert.ok(attack);
  assert.ok(balanced.rankBlend);
  assert.equal(balanced.experimental, true);
  assert.equal(relative.experimental, true);
  assert.equal(attack.experimental, true);
  assert.ok(balanced.rankPullbackWeight >= 0.16);
  assert.ok(relative.rankRelativeWeight >= 0.24);
  assert.ok(attack.rankAccelerationWeight >= 0.16);
  assert.ok(attack.rankOverheatPenalty >= 10);
});

test("paramGrid includes volume-confirmed momentum candidates as experimental params", () => {
  const params = paramGrid();
  const balanced = params.find((item) => item.name === "rank_volume_momentum_balanced_v28");
  const relative = params.find((item) => item.name === "rank_volume_relative_v29");
  const attack = params.find((item) => item.name === "rank_volume_attack_v30");

  assert.ok(balanced);
  assert.ok(relative);
  assert.ok(attack);
  assert.equal(balanced.experimental, true);
  assert.equal(relative.experimental, true);
  assert.equal(attack.experimental, true);
  assert.ok(balanced.rankVolumeMomentumWeight >= 0.16);
  assert.ok(relative.rankRelativeWeight >= 0.24);
  assert.ok(attack.rankAccelerationWeight >= 0.16);
  assert.ok(attack.rankOverheatPenalty >= 10);
});

test("paramGrid includes benchmark-state relative candidates as experimental params", () => {
  const params = paramGrid();
  const balanced = params.find((item) => item.name === "rank_benchmark_state_relative_v31");
  const aggressive = params.find((item) => item.name === "rank_benchmark_state_attack_v32");
  const resilient = params.find((item) => item.name === "rank_benchmark_state_resilient_v33");

  assert.ok(balanced);
  assert.ok(aggressive);
  assert.ok(resilient);
  assert.equal(balanced.experimental, true);
  assert.equal(aggressive.experimental, true);
  assert.equal(resilient.experimental, true);
  assert.ok(balanced.rankBenchmarkTrendWeight >= 0.30);
  assert.ok(balanced.rankRelativeMomentumWeight >= 0.18);
  assert.ok(resilient.rankStabilityWeight >= 0.14);
});

test("paramGrid includes 52-week-high momentum candidates as experimental params", () => {
  const params = paramGrid();
  const relative = params.find((item) => item.name === "rank_52w_high_relative_v34");
  const attack = params.find((item) => item.name === "rank_52w_high_attack_v35");
  const resilient = params.find((item) => item.name === "rank_52w_high_resilient_v36");

  assert.ok(relative);
  assert.ok(attack);
  assert.ok(resilient);
  assert.equal(relative.experimental, true);
  assert.equal(attack.experimental, true);
  assert.equal(resilient.experimental, true);
  assert.ok(relative.rankHigh52wWeight >= 0.16);
  assert.ok(attack.rankHigh52wWeight >= 0.20);
  assert.ok(resilient.rankStabilityWeight >= 0.16);
});

test("paramGrid includes defensive cash candidates as experimental params", () => {
  const params = paramGrid();
  const balanced = params.find((item) => item.name === "balanced_defensive_cash_v37");
  const resilient = params.find((item) => item.name === "rank_resilient_defensive_cash_v38");
  const betaCushion = params.find((item) => item.name === "balanced_beta_cushion_v39");

  assert.ok(balanced);
  assert.ok(resilient);
  assert.ok(betaCushion);
  assert.equal(balanced.experimental, true);
  assert.equal(resilient.experimental, true);
  assert.equal(betaCushion.experimental, true);
  assert.equal(balanced.benchmarkOverlay.defensiveCash.enabled, true);
  assert.ok(balanced.benchmarkOverlay.defensiveCash.maxWeight <= 0.45);
  assert.equal(betaCushion.benchmarkOverlay.enabled, true);
  assert.ok(betaCushion.benchmarkOverlay.maxWeight >= 0.40);
  assert.ok(resilient.rankBlend);
});

test("paramGrid includes industry-residual momentum candidates as experimental params", () => {
  const params = paramGrid();
  const balanced = params.find((item) => item.name === "rank_industry_residual_balanced_v40");
  const attack = params.find((item) => item.name === "rank_industry_residual_attack_v41");
  const cushion = params.find((item) => item.name === "rank_industry_residual_beta_cushion_v42");

  assert.ok(balanced);
  assert.ok(attack);
  assert.ok(cushion);
  assert.equal(balanced.experimental, true);
  assert.equal(attack.experimental, true);
  assert.equal(cushion.experimental, true);
  assert.ok(balanced.rankIndustryResidualWeight >= 0.18);
  assert.ok(attack.rankAccelerationWeight >= 0.10);
  assert.equal(cushion.benchmarkOverlay.enabled, true);
});

test("paramGrid includes dynamic group universe filters as experimental params", () => {
  const params = paramGrid();
  const concept = params.find((item) => item.name === "balanced_dynamic_concept_failopen_v43");
  const combined = params.find((item) => item.name === "balanced_dynamic_both_failopen_v44");
  const conceptCoverage = params.find((item) => item.name === "balanced_dynamic_concept_coverage_v45");
  const conceptGuarded = params.find((item) => item.name === "balanced_dynamic_concept_guarded_v46");
  const betaCushion = params.find((item) => item.name === "balanced_beta_cushion_v39");

  assert.ok(concept);
  assert.ok(combined);
  assert.ok(conceptCoverage);
  assert.ok(conceptGuarded);
  assert.equal(concept.experimental, true);
  assert.equal(combined.experimental, true);
  assert.equal(conceptCoverage.experimental, true);
  assert.equal(conceptGuarded.experimental, true);
  assert.equal(concept.universeFilter.enabled, true);
  assert.equal(combined.universeFilter.enabled, true);
  assert.equal(conceptCoverage.universeFilter.enabled, true);
  assert.equal(conceptGuarded.universeFilter.enabled, true);
  assert.deepEqual(concept.universeFilter.dynamicGroup, {
    enabled: true,
    groupBy: "concept",
    minGroupSize: 5,
    minGroupScore: 52,
    minBreadth20: 0.40,
  });
  assert.deepEqual(combined.universeFilter.dynamicGroup, {
    enabled: true,
    groupBy: "both",
    minGroupSize: 5,
    minGroupScore: 52,
    minBreadth20: 0.40,
  });
  assert.deepEqual(conceptCoverage.universeFilter.dynamicGroup, {
    enabled: true,
    groupBy: "concept",
    minGroupSize: 5,
    minGroupScore: 52,
    minBreadth20: 0.40,
    minRemainingRatio: 0.25,
  });
  assert.deepEqual(conceptGuarded.universeFilter.dynamicGroup, {
    enabled: true,
    groupBy: "concept",
    minGroupSize: 5,
    minGroupScore: 52,
    minBreadth20: 0.40,
    minRemainingRatio: 0.20,
  });
  assert.deepEqual(concept.benchmarkOverlay, betaCushion.benchmarkOverlay);
  assert.deepEqual(combined.benchmarkOverlay, betaCushion.benchmarkOverlay);
  assert.deepEqual(conceptCoverage.benchmarkOverlay, betaCushion.benchmarkOverlay);
  assert.deepEqual(conceptGuarded.benchmarkOverlay, betaCushion.benchmarkOverlay);
});

test("paramGrid includes dynamic group rank candidates as experimental params", () => {
  const params = paramGrid();
  const conceptRank = params.find((item) => item.name === "rank_dynamic_concept_strength_v47");
  const betaCushion = params.find((item) => item.name === "balanced_beta_cushion_v39");

  assert.ok(conceptRank);
  assert.equal(conceptRank.experimental, true);
  assert.equal(conceptRank.rankBlend, true);
  assert.equal(conceptRank.dynamicGroupMetrics.enabled, true);
  assert.equal(conceptRank.dynamicGroupMetrics.groupBy, "concept");
  assert.ok(conceptRank.rankDynamicGroupWeight >= 0.16);
  assert.equal(conceptRank.benchmarkOverlay.enabled, true);
  assert.deepEqual(conceptRank.benchmarkOverlay, betaCushion.benchmarkOverlay);
});

test("paramGrid includes dynamic group score-blend candidates as experimental params", () => {
  const params = paramGrid();
  const conceptBlend = params.find((item) => item.name === "balanced_dynamic_concept_tiebreaker_v48");
  const conceptMicroblend = params.find((item) => item.name === "balanced_dynamic_concept_microblend_v49");
  const bothMicroblend = params.find((item) => item.name === "balanced_dynamic_both_microblend_v50");
  const sourceMicroblend = params.find((item) => item.name === "balanced_dynamic_source_microblend_v60");
  const betaCushion = params.find((item) => item.name === "balanced_beta_cushion_v39");

  assert.ok(conceptBlend);
  assert.ok(conceptMicroblend);
  assert.ok(bothMicroblend);
  assert.ok(sourceMicroblend);
  assert.equal(conceptBlend.experimental, true);
  assert.equal(conceptMicroblend.experimental, true);
  assert.equal(bothMicroblend.experimental, true);
  assert.equal(sourceMicroblend.experimental, true);
  assert.equal(conceptBlend.rankBlend, undefined);
  assert.equal(conceptBlend.dynamicGroupMetrics.enabled, true);
  assert.equal(conceptBlend.dynamicGroupMetrics.groupBy, "concept");
  assert.ok(conceptBlend.dynamicGroupMetrics.scoreWeight > 0);
  assert.ok(conceptBlend.dynamicGroupMetrics.scoreWeight <= 0.10);
  assert.equal(conceptMicroblend.dynamicGroupMetrics.scoreWeight, 0.03);
  assert.equal(conceptMicroblend.dynamicGroupMetrics.groupBy, "concept");
  assert.equal(bothMicroblend.dynamicGroupMetrics.scoreWeight, 0.03);
  assert.equal(bothMicroblend.dynamicGroupMetrics.groupBy, "both");
  assert.equal(sourceMicroblend.dynamicGroupMetrics.scoreWeight, 0.04);
  assert.equal(sourceMicroblend.dynamicGroupMetrics.groupBy, "source");
  assert.deepEqual(conceptBlend.benchmarkOverlay, betaCushion.benchmarkOverlay);
  assert.deepEqual(conceptMicroblend.benchmarkOverlay, betaCushion.benchmarkOverlay);
  assert.deepEqual(bothMicroblend.benchmarkOverlay, betaCushion.benchmarkOverlay);
  assert.equal(sourceMicroblend.benchmarkOverlay.maxWeight >= betaCushion.benchmarkOverlay.maxWeight, true);
});

test("paramGrid includes reversal-stability candidates as experimental params", () => {
  const params = paramGrid();
  const balanced = params.find((item) => item.name === "balanced_reversal_stability_v51");
  const rank = params.find((item) => item.name === "rank_reversal_stability_v52");
  const betaCushion = params.find((item) => item.name === "balanced_beta_cushion_v39");

  assert.ok(balanced);
  assert.ok(rank);
  assert.equal(balanced.experimental, true);
  assert.equal(rank.experimental, true);
  assert.ok(balanced.reversalScoreWeight > 0);
  assert.ok(balanced.turnoverStabilityScoreWeight > 0);
  assert.equal(rank.rankBlend, true);
  assert.ok(rank.rankShortTermReversalWeight > 0);
  assert.ok(rank.rankTurnoverStabilityWeight > 0);
  assert.deepEqual(balanced.benchmarkOverlay, betaCushion.benchmarkOverlay);
});

test("paramGrid includes fresh-trend candidates as experimental params", () => {
  const params = paramGrid();
  const balanced = params.find((item) => item.name === "balanced_fresh_reversal_v53");
  const rank = params.find((item) => item.name === "rank_fresh_reversal_v54");
  const exhaustion = params.find((item) => item.name === "balanced_reversal_stability_exhaustion_cash_v55");
  const selectiveExhaustion = params.find((item) => item.name === "balanced_reversal_stability_selective_exhaustion_cash_v56");
  const matureExhaustion = params.find((item) => item.name === "balanced_reversal_stability_mature_exhaustion_cash_v57");
  const betaRecovery = params.find((item) => item.name === "balanced_reversal_stability_beta_recovery_v58");
  const strongerBetaRecovery = params.find((item) => item.name === "balanced_reversal_stability_beta_recovery_stronger_v59");
  const matureBetaRotation = params.find((item) => item.name === "balanced_reversal_stability_mature_beta_rotation_v61");
  const pullbackCatchup = params.find((item) => item.name === "balanced_reversal_stability_benchmark_pullback_catchup_v62");
  const strongerMatureBetaRotation = params.find((item) => item.name === "balanced_reversal_stability_mature_beta_rotation_stronger_v63");
  const lotteryGuard = params.find((item) => item.name === "rank_fresh_reversal_lottery_guard_v64");
  const betaCushion = params.find((item) => item.name === "balanced_beta_cushion_v39");

  assert.ok(balanced);
  assert.ok(rank);
  assert.ok(exhaustion);
  assert.ok(selectiveExhaustion);
  assert.ok(matureExhaustion);
  assert.ok(betaRecovery);
  assert.ok(strongerBetaRecovery);
  assert.ok(matureBetaRotation);
  assert.ok(pullbackCatchup);
  assert.ok(strongerMatureBetaRotation);
  assert.ok(lotteryGuard);
  assert.equal(balanced.experimental, true);
  assert.equal(rank.experimental, true);
  assert.equal(exhaustion.experimental, true);
  assert.equal(selectiveExhaustion.experimental, true);
  assert.equal(matureExhaustion.experimental, true);
  assert.equal(betaRecovery.experimental, true);
  assert.equal(strongerBetaRecovery.experimental, true);
  assert.equal(matureBetaRotation.experimental, true);
  assert.equal(pullbackCatchup.experimental, true);
  assert.equal(strongerMatureBetaRotation.experimental, true);
  assert.equal(lotteryGuard.experimental, true);
  assert.equal(betaRecovery.walkForwardOverlayOnly, true);
  assert.equal(strongerBetaRecovery.walkForwardOverlayOnly, true);
  assert.equal(matureBetaRotation.walkForwardOverlayOnly, true);
  assert.equal(pullbackCatchup.walkForwardOverlayOnly, true);
  assert.equal(strongerMatureBetaRotation.walkForwardOverlayOnly, true);
  assert.ok(balanced.freshTrendScoreWeight > 0);
  assert.ok(balanced.reversalScoreWeight > 0);
  assert.equal(rank.rankBlend, true);
  assert.ok(rank.rankFreshTrendWeight > 0);
  assert.ok(rank.rankShortTermReversalWeight > 0);
  assert.equal(lotteryGuard.rankBlend, true);
  assert.ok(lotteryGuard.rankLotterySpikeWeight > 0);
  assert.ok(lotteryGuard.rankFreshTrendWeight > 0);
  assert.equal(exhaustion.benchmarkOverlay.exhaustionCash.enabled, true);
  assert.ok(exhaustion.benchmarkOverlay.exhaustionCash.maxWeight <= 0.35);
  assert.equal(selectiveExhaustion.benchmarkOverlay.exhaustionCash.enabled, true);
  assert.ok(selectiveExhaustion.benchmarkOverlay.exhaustionCash.maxTopRelativeR20 <= 0.20);
  assert.ok(selectiveExhaustion.benchmarkOverlay.exhaustionCash.maxRelativeMomentumScore <= 82);
  assert.equal(matureExhaustion.benchmarkOverlay.exhaustionCash.enabled, true);
  assert.equal(matureExhaustion.benchmarkOverlay.exhaustionCash.topOnlyMaturity.enabled, true);
  assert.ok(matureExhaustion.benchmarkOverlay.exhaustionCash.topOnlyMaturity.minTopR60 >= 0.65);
  assert.equal(matureBetaRotation.benchmarkOverlay.exhaustionCash.topOnlyMaturity.asBenchmarkOverlay, true);
  assert.ok(matureBetaRotation.benchmarkOverlay.exhaustionCash.topOnlyMaturity.maxBenchmarkR60ForOverlay <= 0.12);
  assert.equal(strongerMatureBetaRotation.benchmarkOverlay.exhaustionCash.topOnlyMaturity.asBenchmarkOverlay, true);
  assert.ok(
    strongerMatureBetaRotation.benchmarkOverlay.exhaustionCash.topOnlyMaturity.minWeight >
      matureBetaRotation.benchmarkOverlay.exhaustionCash.topOnlyMaturity.minWeight
  );
  assert.ok(
    strongerMatureBetaRotation.benchmarkOverlay.exhaustionCash.topOnlyMaturity.maxWeight >
      matureBetaRotation.benchmarkOverlay.exhaustionCash.topOnlyMaturity.maxWeight
  );
  assert.equal(betaRecovery.benchmarkOverlay.enabled, true);
  assert.ok(betaRecovery.benchmarkOverlay.minWeight >= 0.12);
  assert.equal(strongerBetaRecovery.benchmarkOverlay.enabled, true);
  assert.ok(strongerBetaRecovery.benchmarkOverlay.minWeight > betaRecovery.benchmarkOverlay.minWeight);
  assert.ok(strongerBetaRecovery.benchmarkOverlay.maxWeight > betaRecovery.benchmarkOverlay.maxWeight);
  assert.equal(pullbackCatchup.benchmarkOverlay.pullbackCatchupOverlay.enabled, true);
  assert.ok(pullbackCatchup.benchmarkOverlay.pullbackCatchupOverlay.minTopR60 >= 0.45);
  assert.ok(pullbackCatchup.benchmarkOverlay.pullbackCatchupOverlay.maxBenchmarkR60 <= 0.12);
  assert.deepEqual(balanced.benchmarkOverlay, betaCushion.benchmarkOverlay);
  assert.deepEqual(rank.benchmarkOverlay, betaCushion.benchmarkOverlay);
});

test("optimizeParams penalizes parameters that overfit training and fail holdout", () => {
  const rows = optimizeParams(new Map([
    ["training_star_holdout_fail", [
      { weightedExcessVsBenchmark: 0.12, weightedTopReturn: 0.16, topMeanReturn: 0.14, universeMeanReturn: 0.03, benchmarkReturn: 0.04 },
      { weightedExcessVsBenchmark: 0.10, weightedTopReturn: 0.11, topMeanReturn: 0.10, universeMeanReturn: -0.02, benchmarkReturn: -0.01 },
      { weightedExcessVsBenchmark: -0.18, weightedTopReturn: -0.04, topMeanReturn: -0.03, universeMeanReturn: 0.04, benchmarkReturn: 0.12 },
    ]],
    ["steadier_holdout", [
      { weightedExcessVsBenchmark: 0.04, weightedTopReturn: 0.07, topMeanReturn: 0.06, universeMeanReturn: 0.03, benchmarkReturn: 0.04 },
      { weightedExcessVsBenchmark: 0.03, weightedTopReturn: 0.03, topMeanReturn: 0.02, universeMeanReturn: -0.02, benchmarkReturn: -0.01 },
      { weightedExcessVsBenchmark: 0.02, weightedTopReturn: 0.15, topMeanReturn: 0.13, universeMeanReturn: 0.04, benchmarkReturn: 0.12 },
    ]],
  ]), 2);

  assert.equal(rows[0].name, "steadier_holdout");
  assert.equal(rows[0].selectionMode, "robust_train_holdout");
  assert.ok(rows[0].selectionScore > rows[1].selectionScore);
});

test("optimizeParams balances absolute profit with benchmark excess", () => {
  const rows = optimizeParams(new Map([
    ["high_profit_positive_excess", [
      { adaptiveExcessVsBenchmark: 0.03, adaptiveWeightedTopReturn: 0.18, weightedTopReturn: 0.18, topMeanReturn: 0.17, benchmarkReturn: 0.15 },
      { adaptiveExcessVsBenchmark: 0.02, adaptiveWeightedTopReturn: 0.20, weightedTopReturn: 0.20, topMeanReturn: 0.19, benchmarkReturn: 0.18 },
      { adaptiveExcessVsBenchmark: 0.02, adaptiveWeightedTopReturn: 0.12, weightedTopReturn: 0.12, topMeanReturn: 0.11, benchmarkReturn: 0.10 },
    ]],
    ["low_profit_higher_excess", [
      { adaptiveExcessVsBenchmark: 0.06, adaptiveWeightedTopReturn: 0.04, weightedTopReturn: 0.04, topMeanReturn: 0.04, benchmarkReturn: -0.02 },
      { adaptiveExcessVsBenchmark: 0.05, adaptiveWeightedTopReturn: 0.05, weightedTopReturn: 0.05, topMeanReturn: 0.05, benchmarkReturn: 0 },
      { adaptiveExcessVsBenchmark: 0.05, adaptiveWeightedTopReturn: 0.03, weightedTopReturn: 0.03, topMeanReturn: 0.03, benchmarkReturn: -0.02 },
    ]],
  ]), 2);

  assert.equal(rows[0].name, "high_profit_positive_excess");
  assert.ok(rows[0].trainingAvgReturn > rows[1].trainingAvgReturn);
  assert.ok(rows[0].selectionScore > rows[1].selectionScore);
});

test("optimizeParams prefers net returns when execution costs are available", () => {
  const rows = optimizeParams(new Map([
    ["high_gross_low_net", [
      { adaptiveWeightedTopReturn: 0.22, netAdaptiveWeightedTopReturn: 0.02, adaptiveExcessVsBenchmark: 0.10, netAdaptiveExcessVsBenchmark: -0.08 },
      { adaptiveWeightedTopReturn: 0.18, netAdaptiveWeightedTopReturn: 0.01, adaptiveExcessVsBenchmark: 0.08, netAdaptiveExcessVsBenchmark: -0.09 },
      { adaptiveWeightedTopReturn: 0.16, netAdaptiveWeightedTopReturn: 0.00, adaptiveExcessVsBenchmark: 0.07, netAdaptiveExcessVsBenchmark: -0.10 },
    ]],
    ["lower_gross_higher_net", [
      { adaptiveWeightedTopReturn: 0.12, netAdaptiveWeightedTopReturn: 0.10, adaptiveExcessVsBenchmark: 0.04, netAdaptiveExcessVsBenchmark: 0.02 },
      { adaptiveWeightedTopReturn: 0.11, netAdaptiveWeightedTopReturn: 0.09, adaptiveExcessVsBenchmark: 0.03, netAdaptiveExcessVsBenchmark: 0.01 },
      { adaptiveWeightedTopReturn: 0.10, netAdaptiveWeightedTopReturn: 0.08, adaptiveExcessVsBenchmark: 0.02, netAdaptiveExcessVsBenchmark: 0.00 },
    ]],
  ]), 2);

  assert.equal(rows[0].name, "lower_gross_higher_net");
  assert.ok(rows[0].trainingAvgReturn > rows[1].trainingAvgReturn);
});

test("benchmark-relative metrics use only benchmark history before asOf", () => {
  const stock = scoreAtDate(
    fixtureRows[0],
    makeKline(10, 1, 4),
    "2026-04-04",
    { momentumWeight: 0.55, liquidityWeight: 0.15, stabilityWeight: 0.15, themeWeight: 0.15 }
  );
  const benchmarkFutureStrong = makeKline(10, 0.5, 6);
  const benchmarkFutureWeak = makeKline(10, 0.5, -0.2);
  const first = applyBenchmarkRelativeMetrics({ ...stock }, benchmarkFutureStrong, "2026-04-04");
  const second = applyBenchmarkRelativeMetrics({ ...stock }, benchmarkFutureWeak, "2026-04-04");

  assert.equal(first.benchmarkR20, second.benchmarkR20);
  assert.equal(first.relativeR20, second.relativeR20);
  assert.equal(first.relativeMomentumScore, second.relativeMomentumScore);
  assert.ok(Number.isFinite(first.relativeMomentumScore));
});

test("applyIndustryMomentumMetrics scores only sufficiently broad industry groups", () => {
  const rows = [
    { code: "000001", industry: "半导体", r20: 0.20, r60: 0.30, relativeR20: 0.12, relativeR60: 0.18 },
    { code: "000002", industry: "半导体", r20: 0.16, r60: 0.25, relativeR20: 0.08, relativeR60: 0.15 },
    { code: "000003", industry: "半导体", r20: 0.10, r60: 0.20, relativeR20: 0.05, relativeR60: 0.10 },
    { code: "000004", industry: "单票行业", r20: 0.50, r60: 0.60, relativeR20: 0.40, relativeR60: 0.50 },
  ];
  applyIndustryMomentumMetrics(rows, { industryMinGroupSize: 3 });

  assert.ok(rows.slice(0, 3).every((row) => Number.isFinite(row.industryMomentumScore)));
  assert.ok(rows[0].industryMomentumScore > 50);
  assert.equal(rows[0].industryCount, 3);
  assert.equal(rows[3].industryMomentumScore, undefined);
});

test("applyIndustryMomentumMetrics computes within-industry residual momentum", () => {
  const rows = [
    { code: "000001", industry: "半导体", r20: 0.30, r60: 0.45, relativeR20: 0.22, relativeR60: 0.32 },
    { code: "000002", industry: "半导体", r20: 0.12, r60: 0.20, relativeR20: 0.05, relativeR60: 0.08 },
    { code: "000003", industry: "半导体", r20: 0.06, r60: 0.10, relativeR20: 0.02, relativeR60: 0.03 },
    { code: "000004", industry: "机器人", r20: 0.08, r60: 0.12, relativeR20: 0.01, relativeR60: 0.02 },
    { code: "000005", industry: "机器人", r20: 0.07, r60: 0.11, relativeR20: 0.01, relativeR60: 0.01 },
    { code: "000006", industry: "机器人", r20: 0.06, r60: 0.10, relativeR20: 0.00, relativeR60: 0.01 },
  ];
  applyIndustryMomentumMetrics(rows, { industryMinGroupSize: 3 });

  assert.ok(rows[0].industryResidualR20 > 0);
  assert.ok(rows[0].industryResidualR60 > 0);
  assert.ok(rows[0].industryResidualMomentumScore > rows[1].industryResidualMomentumScore);
  assert.ok(rows[3].industryResidualMomentumScore > 50, "top stock inside a weak industry should still receive within-industry credit");
  assert.ok(rows[2].industryResidualMomentumScore < 50);
});

test("applyCrossSectionalRankScore can reward within-industry residual momentum", () => {
  const rows = [
    { code: "000001", score: 60, r5: 0.01, r20: 0.12, r60: 0.20, dd60: -0.05, vol20: 0.35, avgTurnover20: 1e9, themeScore: 60, industryMomentumScore: 80, industryResidualMomentumScore: 35 },
    { code: "000002", score: 60, r5: 0.01, r20: 0.10, r60: 0.18, dd60: -0.05, vol20: 0.35, avgTurnover20: 1e9, themeScore: 60, industryMomentumScore: 55, industryResidualMomentumScore: 90 },
    { code: "000003", score: 60, r5: 0.01, r20: 0.09, r60: 0.16, dd60: -0.05, vol20: 0.35, avgTurnover20: 1e9, themeScore: 60, industryMomentumScore: 45, industryResidualMomentumScore: 25 },
  ];
  applyCrossSectionalRankScore(rows, {
    rankBlend: true,
    rankMomentumWeight: 0.10,
    rankStabilityWeight: 0.10,
    rankLiquidityWeight: 0.05,
    rankThemeWeight: 0.05,
    rankIndustryResidualWeight: 0.70,
    rankRawScoreWeight: 0,
    rankOverheatPenalty: 0,
  });

  assert.ok(rows[1].industryResidualRankScore > rows[0].industryResidualRankScore);
  assert.ok(rows[1].score > rows[0].score);
});

test("benchmarkOverlayWeight adds an index sleeve in strong benchmark beta without reading future returns", () => {
  const baseTop = assignRecommendedWeights([
    { code: "000001", score: 90, liquidityScore: 85, stabilityScore: 70, vol20: 0.45, dd60: -0.08, benchmarkR20: 0.18, benchmarkR60: 0.42, relativeR20: -0.02, relativeR60: 0.04, forwardReturn: 0.12, benchmarkForwardReturn: 0.48 },
    { code: "000002", score: 88, liquidityScore: 80, stabilityScore: 72, vol20: 0.40, dd60: -0.06, benchmarkR20: 0.18, benchmarkR60: 0.42, relativeR20: 0.03, relativeR60: 0.02, forwardReturn: 0.08, benchmarkForwardReturn: 0.48 },
  ], { minWeight: 0.20, maxWeight: 0.80 });
  const changedFuture = baseTop.map((row) => ({
    ...row,
    forwardReturn: row.forwardReturn * -2,
    benchmarkForwardReturn: row.benchmarkForwardReturn * -1,
  }));
  const options = { enabled: true, trigger20: 0.08, strong20: 0.18, trigger60: 0.18, strong60: 0.38, minWeight: 0.10, maxWeight: 0.55 };

  const weight = benchmarkOverlayWeight(baseTop, options);
  assert.ok(weight >= 0.35, `expected meaningful benchmark sleeve in strong beta regime, got ${weight}`);
  assert.equal(weight, benchmarkOverlayWeight(changedFuture, options), "overlay weight must not depend on future period returns");
});

test("adaptivePortfolioStats improves absolute return when strong beta benchmark beats the Top basket", () => {
  const top = assignRecommendedWeights([
    { code: "000001", score: 90, liquidityScore: 85, stabilityScore: 70, vol20: 0.45, dd60: -0.08, benchmarkR20: 0.18, benchmarkR60: 0.42, relativeR20: -0.02, relativeR60: 0.04, forwardReturn: 0.12, benchmarkForwardReturn: 0.48 },
    { code: "000002", score: 88, liquidityScore: 80, stabilityScore: 72, vol20: 0.40, dd60: -0.06, benchmarkR20: 0.18, benchmarkR60: 0.42, relativeR20: 0.03, relativeR60: 0.02, forwardReturn: 0.08, benchmarkForwardReturn: 0.48 },
  ], { minWeight: 0.20, maxWeight: 0.80 });

  const stats = adaptivePortfolioStats(top, { enabled: true, trigger20: 0.08, strong20: 0.18, trigger60: 0.18, strong60: 0.38, minWeight: 0.10, maxWeight: 0.55 });
  assert.ok(stats.benchmarkOverlayWeight > 0);
  assert.ok(stats.adaptiveWeightedReturn > stats.weightedTopReturn);
  assert.ok(stats.adaptiveExcessVsBenchmark > stats.weightedExcessVsBenchmark);
});

test("adaptivePortfolioStats can use pre-asOf benchmark weakness for a defensive cash sleeve", () => {
  const weakBenchmarkTopRows = [
    {
      recommendedWeight: 0.5,
      forwardReturn: -0.22,
      benchmarkForwardReturn: -0.05,
      benchmarkR20: -0.12,
      benchmarkR60: -0.24,
      relativeR20: 0.02,
      relativeR60: 0.03,
    },
    {
      recommendedWeight: 0.5,
      forwardReturn: -0.18,
      benchmarkForwardReturn: -0.04,
      benchmarkR20: -0.10,
      benchmarkR60: -0.20,
      relativeR20: 0.01,
      relativeR60: 0.02,
    },
  ];
  const strongBenchmarkTopRows = weakBenchmarkTopRows.map((row) => ({
    ...row,
    benchmarkR20: 0.12,
    benchmarkR60: 0.24,
  }));

  const weakStats = adaptivePortfolioStats(weakBenchmarkTopRows, {
    defensiveCash: { enabled: true, maxWeight: 0.5 },
  });
  const strongStats = adaptivePortfolioStats(strongBenchmarkTopRows, {
    defensiveCash: { enabled: true, maxWeight: 0.5 },
  });

  assert.ok(weakStats.defensiveCashWeight > 0, "expected cash sleeve from weak pre-asOf benchmark trend");
  assert.equal(strongStats.defensiveCashWeight, 0, "strong pre-asOf benchmark trend must not allocate cash just because future returns are bad");
  assert.ok(
    weakStats.adaptiveWeightedReturn > weakStats.weightedTopReturn,
    `expected cash sleeve to reduce drawdown: ${weakStats.adaptiveWeightedReturn} vs ${weakStats.weightedTopReturn}`
  );
});

test("adaptivePortfolioStats can use pre-asOf rally deceleration for exhaustion cash without reading future returns", () => {
  const deceleratingRallyRows = [
    {
      recommendedWeight: 0.5,
      forwardReturn: -0.18,
      benchmarkForwardReturn: -0.04,
      benchmarkR20: 0.07,
      benchmarkR60: 0.30,
      r60: 0.48,
      vol20: 0.56,
      relativeR20: 0.02,
      relativeR60: 0.03,
    },
    {
      recommendedWeight: 0.5,
      forwardReturn: -0.14,
      benchmarkForwardReturn: -0.03,
      benchmarkR20: 0.08,
      benchmarkR60: 0.30,
      r60: 0.44,
      vol20: 0.52,
      relativeR20: 0.01,
      relativeR60: 0.02,
    },
  ];
  const futureFlippedRows = deceleratingRallyRows.map((row) => ({
    ...row,
    forwardReturn: Math.abs(row.forwardReturn) + 0.10,
    benchmarkForwardReturn: Math.abs(row.benchmarkForwardReturn) + 0.08,
  }));
  const noDecelerationRows = deceleratingRallyRows.map((row) => ({
    ...row,
    benchmarkR20: 0.22,
    benchmarkR60: 0.30,
  }));
  const options = {
    exhaustionCash: {
      enabled: true,
      trigger60: 0.20,
      full60: 0.35,
      max20To60Ratio: 0.35,
      ratioFull: 0.10,
      minTopR60: 0.35,
      minTopVol20: 0.45,
      activation: 0.20,
      minWeight: 0.08,
      maxWeight: 0.35,
    },
  };

  const deceleratingStats = adaptivePortfolioStats(deceleratingRallyRows, options);
  const futureFlippedStats = adaptivePortfolioStats(futureFlippedRows, options);
  const noDecelerationStats = adaptivePortfolioStats(noDecelerationRows, options);

  assert.ok(deceleratingStats.exhaustionCashWeight > 0, "expected cash from pre-asOf rally exhaustion state");
  assert.equal(
    deceleratingStats.exhaustionCashWeight,
    futureFlippedStats.exhaustionCashWeight,
    "exhaustion cash weight must not depend on future period returns"
  );
  assert.equal(noDecelerationStats.exhaustionCashWeight, 0, "strong current benchmark momentum should not trigger exhaustion cash");
  assert.ok(
    deceleratingStats.adaptiveWeightedReturn > deceleratingStats.weightedTopReturn,
    `expected exhaustion cash to reduce drawdown: ${deceleratingStats.adaptiveWeightedReturn} vs ${deceleratingStats.weightedTopReturn}`
  );
});

test("adaptivePortfolioStats does not use exhaustion cash when Top basket relative confirmation remains strong", () => {
  const strongRelativeRows = [
    {
      recommendedWeight: 0.5,
      forwardReturn: 0.24,
      benchmarkForwardReturn: -0.03,
      benchmarkR20: 0.02,
      benchmarkR60: 0.24,
      r60: 0.54,
      vol20: 0.62,
      relativeR20: 0.26,
      relativeR60: 0.30,
      relativeMomentumScore: 90,
    },
    {
      recommendedWeight: 0.5,
      forwardReturn: 0.18,
      benchmarkForwardReturn: -0.02,
      benchmarkR20: 0.01,
      benchmarkR60: 0.22,
      r60: 0.50,
      vol20: 0.58,
      relativeR20: 0.24,
      relativeR60: 0.28,
      relativeMomentumScore: 88,
    },
  ];

  const stats = adaptivePortfolioStats(strongRelativeRows, {
    exhaustionCash: {
      enabled: true,
      trigger60: 0.20,
      full60: 0.35,
      max20To60Ratio: 0.35,
      ratioFull: 0.05,
      minTopR60: 0.35,
      minTopVol20: 0.45,
      maxTopRelativeR20: 0.20,
      maxRelativeMomentumScore: 82,
      activation: 0.20,
      minWeight: 0.08,
      maxWeight: 0.35,
    },
  });

  assert.equal(stats.exhaustionCashWeight, 0, "strong relative confirmation should keep the alpha basket invested");
  assert.equal(stats.defensiveCashWeight, 0);
});

test("adaptivePortfolioStats can cut mature Top basket momentum using only current basket features", () => {
  const matureRows = [
    {
      recommendedWeight: 0.5,
      forwardReturn: -0.08,
      benchmarkForwardReturn: 0.03,
      benchmarkR20: 0.00,
      benchmarkR60: 0.05,
      r60: 0.72,
      acceleration20vs60: -0.08,
      vol20: 0.68,
      freshTrendScore: 44,
      relativeR60: 0.62,
    },
    {
      recommendedWeight: 0.5,
      forwardReturn: -0.04,
      benchmarkForwardReturn: 0.02,
      benchmarkR20: 0.01,
      benchmarkR60: 0.06,
      r60: 0.69,
      acceleration20vs60: -0.06,
      vol20: 0.65,
      freshTrendScore: 46,
      relativeR60: 0.58,
    },
  ];
  const futureFlippedRows = matureRows.map((row) => ({
    ...row,
    forwardReturn: Math.abs(row.forwardReturn) + 0.10,
    benchmarkForwardReturn: Math.abs(row.benchmarkForwardReturn) + 0.03,
  }));
  const stillAcceleratingRows = matureRows.map((row) => ({
    ...row,
    acceleration20vs60: 0.04,
  }));
  const options = {
    exhaustionCash: {
      enabled: true,
      topOnlyMaturity: {
        enabled: true,
        minTopR60: 0.65,
        maxAcceleration20vs60: -0.05,
        minTopVol20: 0.62,
        maxFreshTrendScore: 50,
        minRelativeR60: 0.45,
        activation: 0.20,
        minWeight: 0.10,
        maxWeight: 0.30,
      },
    },
  };

  const matureStats = adaptivePortfolioStats(matureRows, options);
  const futureFlippedStats = adaptivePortfolioStats(futureFlippedRows, options);
  const stillAcceleratingStats = adaptivePortfolioStats(stillAcceleratingRows, options);

  assert.ok(matureStats.exhaustionCashWeight > 0, "expected cash from mature high-volatility Top basket state");
  assert.equal(
    matureStats.exhaustionCashWeight,
    futureFlippedStats.exhaustionCashWeight,
    "mature basket cash weight must not depend on future period returns"
  );
  assert.equal(stillAcceleratingStats.exhaustionCashWeight, 0, "accelerating Top basket should stay invested");
  assert.ok(
    matureStats.adaptiveWeightedReturn > matureStats.weightedTopReturn,
    `expected mature basket cash to reduce drawdown: ${matureStats.adaptiveWeightedReturn} vs ${matureStats.weightedTopReturn}`
  );
});

test("adaptivePortfolioStats can rotate mature Top basket cash into a benchmark sleeve in constructive markets", () => {
  const matureRows = [
    {
      recommendedWeight: 0.5,
      forwardReturn: -0.08,
      benchmarkForwardReturn: 0.04,
      benchmarkR20: 0.00,
      benchmarkR60: 0.05,
      r60: 0.72,
      acceleration20vs60: -0.08,
      vol20: 0.68,
      freshTrendScore: 44,
      relativeR60: 0.62,
    },
    {
      recommendedWeight: 0.5,
      forwardReturn: -0.04,
      benchmarkForwardReturn: 0.03,
      benchmarkR20: 0.01,
      benchmarkR60: 0.06,
      r60: 0.69,
      acceleration20vs60: -0.06,
      vol20: 0.65,
      freshTrendScore: 46,
      relativeR60: 0.58,
    },
  ];
  const overextendedBenchmarkRows = matureRows.map((row) => ({
    ...row,
    benchmarkR20: 0.08,
    benchmarkR60: 0.24,
  }));
  const options = {
    exhaustionCash: {
      enabled: true,
      topOnlyMaturity: {
        enabled: true,
        asBenchmarkOverlay: true,
        minTopR60: 0.65,
        maxAcceleration20vs60: -0.05,
        minTopVol20: 0.62,
        maxFreshTrendScore: 50,
        minRelativeR60: 0.45,
        activation: 0.20,
        minWeight: 0.10,
        maxWeight: 0.30,
        minBenchmarkR20ForOverlay: -0.03,
        maxBenchmarkR20ForOverlay: 0.06,
        minBenchmarkR60ForOverlay: -0.02,
        maxBenchmarkR60ForOverlay: 0.12,
      },
    },
  };
  const strongerOptions = {
    exhaustionCash: {
      enabled: true,
      topOnlyMaturity: {
        ...options.exhaustionCash.topOnlyMaturity,
        minWeight: 0.18,
        maxWeight: 0.50,
      },
    },
  };

  const rotationStats = adaptivePortfolioStats(matureRows, options);
  const strongerRotationStats = adaptivePortfolioStats(matureRows, strongerOptions);
  const overextendedStats = adaptivePortfolioStats(overextendedBenchmarkRows, options);

  assert.ok(rotationStats.benchmarkOverlayWeight > 0, "constructive benchmark state should receive the mature momentum sleeve");
  assert.ok(
    strongerRotationStats.benchmarkOverlayWeight > rotationStats.benchmarkOverlayWeight,
    "stronger mature beta rotation should add more benchmark exposure in the same pre-asOf state"
  );
  assert.equal(rotationStats.exhaustionCashWeight, 0, "routed mature sleeve should not also remain in cash");
  assert.ok(
    rotationStats.adaptiveWeightedReturn > rotationStats.weightedTopReturn,
    "benchmark sleeve should reduce the mature basket drawdown when benchmark return is positive"
  );
  assert.equal(overextendedStats.benchmarkOverlayWeight, 0, "overextended benchmark state should not receive the routed sleeve");
  assert.ok(overextendedStats.exhaustionCashWeight > 0, "overextended benchmark state should keep the mature sleeve as cash");
});

test("adaptivePortfolioStats can add a benchmark sleeve after a benchmark pullback while the Top basket is mature", () => {
  const matureRelativeRows = [
    {
      recommendedWeight: 0.5,
      forwardReturn: 0.08,
      benchmarkForwardReturn: 0.28,
      benchmarkR5: -0.025,
      benchmarkR20: 0.045,
      benchmarkR60: 0.07,
      r60: 0.50,
      freshTrendScore: 66,
      relativeR20: 0.22,
      relativeMomentumScore: 94,
      vol20: 0.54,
    },
    {
      recommendedWeight: 0.5,
      forwardReturn: 0.12,
      benchmarkForwardReturn: 0.26,
      benchmarkR5: -0.023,
      benchmarkR20: 0.043,
      benchmarkR60: 0.068,
      r60: 0.47,
      freshTrendScore: 67,
      relativeR20: 0.21,
      relativeMomentumScore: 93,
      vol20: 0.53,
    },
  ];
  const futureFlippedRows = matureRelativeRows.map((row) => ({
    ...row,
    forwardReturn: row.benchmarkForwardReturn + 0.12,
    benchmarkForwardReturn: row.forwardReturn - 0.04,
  }));
  const notPulledBackRows = matureRelativeRows.map((row) => ({
    ...row,
    benchmarkR5: 0.02,
  }));
  const options = {
    pullbackCatchupOverlay: {
      enabled: true,
      minTopR60: 0.45,
      minFreshTrendScore: 55,
      maxFreshTrendScore: 70,
      maxBenchmarkR5: -0.01,
      minBenchmarkR20: 0.02,
      maxBenchmarkR20: 0.08,
      minBenchmarkR60: 0.02,
      maxBenchmarkR60: 0.12,
      minRelativeR20: 0.18,
      minRelativeMomentumScore: 90,
      maxTopVol20: 0.60,
      minWeight: 0.12,
      maxWeight: 0.28,
    },
  };

  const catchupStats = adaptivePortfolioStats(matureRelativeRows, options);
  const futureFlippedStats = adaptivePortfolioStats(futureFlippedRows, options);
  const notPulledBackStats = adaptivePortfolioStats(notPulledBackRows, options);

  assert.ok(catchupStats.pullbackCatchupOverlayWeight > 0, "expected benchmark sleeve from pre-asOf pullback catch-up state");
  assert.equal(
    catchupStats.pullbackCatchupOverlayWeight,
    futureFlippedStats.pullbackCatchupOverlayWeight,
    "pullback catch-up weight must not depend on future period returns"
  );
  assert.equal(notPulledBackStats.pullbackCatchupOverlayWeight, 0, "benchmark must have pulled back recently");
  assert.ok(
    catchupStats.adaptiveWeightedReturn > catchupStats.weightedTopReturn,
    `expected benchmark sleeve to improve when benchmark later leads: ${catchupStats.adaptiveWeightedReturn} vs ${catchupStats.weightedTopReturn}`
  );
});

test("applyCrossSectionalRankScore can reward fresh 20-day acceleration over stale long trend", () => {
  const rows = [
    {
      code: "000001",
      name: "FreshBreakout",
      score: 60,
      r5: 0.03,
      r20: 0.12,
      r60: 0.03,
      acceleration20vs60: 0.11,
      dd60: -0.04,
      vol20: 0.36,
      avgTurnover20: 800000000,
      themeScore: 65,
    },
    {
      code: "000002",
      name: "StaleTrend",
      score: 60,
      r5: 0.00,
      r20: 0.08,
      r60: 0.48,
      acceleration20vs60: -0.08,
      dd60: -0.03,
      vol20: 0.38,
      avgTurnover20: 900000000,
      themeScore: 65,
    },
  ];
  applyCrossSectionalRankScore(rows, {
    rankMomentumWeight: 0,
    rankAccelerationWeight: 1,
    rankStabilityWeight: 0,
    rankLiquidityWeight: 0,
    rankThemeWeight: 0,
    rankConsistencyWeight: 0,
    rankRawScoreWeight: 0,
    rankOverheatPenalty: 0,
  });

  assert.ok(rows[0].score > rows[1].score, `${rows[0].score} should beat ${rows[1].score}`);
  assert.ok(rows[0].accelerationRankScore > rows[1].accelerationRankScore);
});

test("applyCrossSectionalRankScore can reward constructive pullback accumulation", () => {
  const rows = [
    {
      code: "000001",
      name: "ConstructivePullback",
      score: 60,
      r5: -0.02,
      r20: 0.16,
      r60: 0.24,
      acceleration20vs60: 0.08,
      dd60: -0.04,
      vol20: 0.36,
      avgTurnover20: 800000000,
      themeScore: 65,
      pullbackAccumulationScore: 88,
      forwardReturn: -0.30,
    },
    {
      code: "000002",
      name: "OverheatedBreakout",
      score: 80,
      r5: 0.18,
      r20: 0.35,
      r60: 0.48,
      acceleration20vs60: 0.19,
      dd60: -0.02,
      vol20: 0.72,
      avgTurnover20: 900000000,
      themeScore: 65,
      pullbackAccumulationScore: 28,
      forwardReturn: 0.90,
    },
  ];
  const first = applyCrossSectionalRankScore(rows.map((row) => ({ ...row })), {
    rankMomentumWeight: 0,
    rankAccelerationWeight: 0,
    rankPullbackWeight: 1,
    rankStabilityWeight: 0,
    rankLiquidityWeight: 0,
    rankThemeWeight: 0,
    rankConsistencyWeight: 0,
    rankRawScoreWeight: 0,
    rankOverheatPenalty: 0,
  });
  const changedFuture = applyCrossSectionalRankScore(rows.map((row) => ({ ...row, forwardReturn: row.forwardReturn * -2 })), {
    rankMomentumWeight: 0,
    rankAccelerationWeight: 0,
    rankPullbackWeight: 1,
    rankStabilityWeight: 0,
    rankLiquidityWeight: 0,
    rankThemeWeight: 0,
    rankConsistencyWeight: 0,
    rankRawScoreWeight: 0,
    rankOverheatPenalty: 0,
  });

  assert.ok(first[0].score > first[1].score, `${first[0].score} should beat ${first[1].score}`);
  assert.ok(first[0].pullbackRankScore > first[1].pullbackRankScore);
  assert.deepEqual(first.map((row) => row.score), changedFuture.map((row) => row.score));
});

test("applyCrossSectionalRankScore can reward volume-confirmed momentum", () => {
  const rows = [
    {
      code: "000001",
      name: "VolumeConfirmed",
      score: 60,
      r5: 0.06,
      r20: 0.15,
      r60: 0.18,
      acceleration20vs60: 0.09,
      dd60: -0.04,
      vol20: 0.36,
      avgTurnover20: 800000000,
      themeScore: 65,
      volumeMomentumScore: 86,
      forwardReturn: -0.30,
    },
    {
      code: "000002",
      name: "ThinMomentum",
      score: 82,
      r5: 0.08,
      r20: 0.18,
      r60: 0.20,
      acceleration20vs60: 0.11,
      dd60: -0.03,
      vol20: 0.34,
      avgTurnover20: 900000000,
      themeScore: 65,
      volumeMomentumScore: 22,
      forwardReturn: 0.90,
    },
  ];
  const first = applyCrossSectionalRankScore(rows.map((row) => ({ ...row })), {
    rankMomentumWeight: 0,
    rankAccelerationWeight: 0,
    rankVolumeMomentumWeight: 1,
    rankStabilityWeight: 0,
    rankLiquidityWeight: 0,
    rankThemeWeight: 0,
    rankConsistencyWeight: 0,
    rankRawScoreWeight: 0,
    rankOverheatPenalty: 0,
  });
  const changedFuture = applyCrossSectionalRankScore(rows.map((row) => ({ ...row, forwardReturn: row.forwardReturn * -2 })), {
    rankMomentumWeight: 0,
    rankAccelerationWeight: 0,
    rankVolumeMomentumWeight: 1,
    rankStabilityWeight: 0,
    rankLiquidityWeight: 0,
    rankThemeWeight: 0,
    rankConsistencyWeight: 0,
    rankRawScoreWeight: 0,
    rankOverheatPenalty: 0,
  });

  assert.ok(first[0].score > first[1].score, `${first[0].score} should beat ${first[1].score}`);
  assert.ok(first[0].volumeMomentumRankScore > first[1].volumeMomentumRankScore);
  assert.deepEqual(first.map((row) => row.score), changedFuture.map((row) => row.score));
});

test("applyCrossSectionalRankScore can reward 52-week high proximity", () => {
  const rows = [
    {
      code: "000001",
      name: "NearHigh",
      score: 60,
      r5: 0.02,
      r20: 0.08,
      r60: 0.18,
      acceleration20vs60: 0.02,
      dd60: -0.04,
      vol20: 0.32,
      avgTurnover20: 800000000,
      themeScore: 65,
      high52wScore: 88,
      forwardReturn: -0.30,
    },
    {
      code: "000002",
      name: "FarFromHigh",
      score: 88,
      r5: 0.03,
      r20: 0.09,
      r60: 0.20,
      acceleration20vs60: 0.02,
      dd60: -0.05,
      vol20: 0.30,
      avgTurnover20: 900000000,
      themeScore: 65,
      high52wScore: 24,
      forwardReturn: 0.90,
    },
  ];
  const params = {
    rankMomentumWeight: 0,
    rankAccelerationWeight: 0,
    rankHigh52wWeight: 1,
    rankStabilityWeight: 0,
    rankLiquidityWeight: 0,
    rankThemeWeight: 0,
    rankConsistencyWeight: 0,
    rankRawScoreWeight: 0,
    rankOverheatPenalty: 0,
  };
  const first = applyCrossSectionalRankScore(rows.map((row) => ({ ...row })), params);
  const changedFuture = applyCrossSectionalRankScore(rows.map((row) => ({ ...row, forwardReturn: row.forwardReturn * -2 })), params);

  assert.ok(first[0].score > first[1].score, `${first[0].score} should beat ${first[1].score}`);
  assert.ok(first[0].high52wRankScore > first[1].high52wRankScore);
  assert.deepEqual(first.map((row) => row.score), changedFuture.map((row) => row.score));
});

test("scoreAtDate rewards constructive pullback accumulation after a strong trend", () => {
  const trendThenPullback = [
    ...Array.from({ length: 24 }, (_, i) => 10 * (1 + i * 0.012)),
    12.82,
    12.74,
    12.68,
    12.62,
    12.58,
    12.64,
  ];
  const overheatedStraightRun = [
    ...Array.from({ length: 24 }, (_, i) => 10 * (1 + i * 0.008)),
    12.05,
    12.55,
    13.05,
    13.55,
    14.05,
    14.60,
  ];
  const brokenPullback = [
    ...Array.from({ length: 24 }, (_, i) => 10 * (1 + i * 0.012)),
    12.82,
    12.10,
    11.55,
    11.05,
    10.65,
    10.42,
  ];
  const accumulationVolumes = [
    ...Array.from({ length: 24 }, () => 1_800_000),
    2_000_000,
    980_000,
    920_000,
    900_000,
    870_000,
    960_000,
  ];
  const hotVolumes = Array.from({ length: 30 }, (_, i) => (i < 24 ? 1_500_000 : 3_200_000));
  const brokenVolumes = Array.from({ length: 30 }, (_, i) => (i < 24 ? 1_800_000 : 2_600_000));

  const constructive = scoreAtDate(
    fixtureRows[0],
    makePatternKline("2026-01-01", trendThenPullback, accumulationVolumes),
    "2026-01-30",
    { ...defaultRankParams(), minHistoryDays: 30 }
  );
  const hot = scoreAtDate(
    fixtureRows[1],
    makePatternKline("2026-01-01", overheatedStraightRun, hotVolumes),
    "2026-01-30",
    { ...defaultRankParams(), minHistoryDays: 30 }
  );
  const broken = scoreAtDate(
    fixtureRows[2],
    makePatternKline("2026-01-01", brokenPullback, brokenVolumes),
    "2026-01-30",
    { ...defaultRankParams(), minHistoryDays: 30 }
  );

  assert.ok(Number.isFinite(constructive.pullbackAccumulationScore));
  assert.ok(constructive.pullbackAccumulationScore > hot.pullbackAccumulationScore + 18);
  assert.ok(constructive.pullbackAccumulationScore > broken.pullbackAccumulationScore + 18);
  assert.ok(constructive.pullbackDrawdown20 > -0.08 && constructive.pullbackDrawdown20 < -0.005);
  assert.ok(constructive.pullbackVolumeRatio5v20 < 0.8);
});

test("scoreAtDate rewards volume-confirmed momentum without rewarding thin or frenzy moves", () => {
  const base = Array.from({ length: 25 }, (_, i) => 10 * (1 + i * 0.004));
  const confirmed = [...base, 11.18, 11.34, 11.48, 11.55, 11.62];
  const thin = [...base, 11.16, 11.31, 11.45, 11.54, 11.62];
  const frenzy = [...base, 11.62, 12.10, 12.72, 13.35, 14.10];
  const normalBaseVolume = Array.from({ length: 25 }, () => 1_000_000);
  const confirmedVolume = [...normalBaseVolume, 1_450_000, 1_600_000, 1_700_000, 1_650_000, 1_550_000];
  const thinVolume = [...normalBaseVolume, 420_000, 380_000, 460_000, 410_000, 390_000];
  const frenzyVolume = [...normalBaseVolume, 3_800_000, 4_400_000, 4_900_000, 5_200_000, 5_500_000];

  const confirmedScore = scoreAtDate(
    fixtureRows[0],
    makePatternKline("2026-01-01", confirmed, confirmedVolume),
    "2026-01-30",
    { ...defaultRankParams(), minHistoryDays: 30 }
  );
  const thinScore = scoreAtDate(
    fixtureRows[1],
    makePatternKline("2026-01-01", thin, thinVolume),
    "2026-01-30",
    { ...defaultRankParams(), minHistoryDays: 30 }
  );
  const frenzyScore = scoreAtDate(
    fixtureRows[2],
    makePatternKline("2026-01-01", frenzy, frenzyVolume),
    "2026-01-30",
    { ...defaultRankParams(), minHistoryDays: 30 }
  );

  assert.ok(Number.isFinite(confirmedScore.volumeMomentumScore));
  assert.ok(confirmedScore.volumeMomentumScore > thinScore.volumeMomentumScore + 18);
  assert.ok(confirmedScore.volumeMomentumScore > frenzyScore.volumeMomentumScore + 12);
  assert.ok(confirmedScore.volumeTurnoverRatio5v20 > 1.2 && confirmedScore.volumeTurnoverRatio5v20 < 2.2);
});

test("scoreAtDate computes 52-week high proximity using only pre-asOf history", () => {
  const nearPre = [
    ...Array.from({ length: 220 }, (_, i) => 10 + i * 0.035),
    ...Array.from({ length: 40 }, (_, i) => 17.70 + i * 0.025),
  ];
  const farPre = [
    ...Array.from({ length: 60 }, (_, i) => 25 - i * 0.02),
    ...Array.from({ length: 200 }, (_, i) => 23.75 - i * 0.03),
  ];
  const nearFlatFuture = makePatternKline("2025-07-01", [...nearPre, 18.80, 18.90], Array.from({ length: nearPre.length + 2 }, () => 1_200_000));
  const nearSpikeFuture = makePatternKline("2025-07-01", [...nearPre, 28.00, 31.00], Array.from({ length: nearPre.length + 2 }, () => 1_200_000));
  const far = makePatternKline("2025-07-01", [...farPre, 18.00, 18.10], Array.from({ length: farPre.length + 2 }, () => 1_200_000));
  const asOf = nearFlatFuture[nearPre.length - 1].date;
  const params = { ...defaultRankParams(), minHistoryDays: 252 };

  const nearFlatScore = scoreAtDate(fixtureRows[0], nearFlatFuture, asOf, params);
  const nearSpikeScore = scoreAtDate(fixtureRows[1], nearSpikeFuture, asOf, params);
  const farScore = scoreAtDate(fixtureRows[2], far, asOf, params);

  assert.ok(Number.isFinite(nearFlatScore.high52wScore));
  assert.equal(nearFlatScore.high52wScore, nearSpikeScore.high52wScore);
  assert.equal(nearFlatScore.high52wDistance, nearSpikeScore.high52wDistance);
  assert.equal(nearFlatScore.high52wDaysSinceHigh, nearSpikeScore.high52wDaysSinceHigh);
  assert.ok(nearFlatScore.high52wScore > farScore.high52wScore + 25);
  assert.ok(nearFlatScore.high52wDistance > -0.06 && nearFlatScore.high52wDistance <= 0);
  assert.ok(farScore.high52wDaysSinceHigh > 150);
});

test("walkForwardOptimize selects each period using only prior period results", () => {
  const makeResult = (period, excess, top = 0.1) => {
    const [asOf, end] = period.split(":");
    return {
      asOf,
      end,
      adaptiveExcessVsBenchmark: excess,
      weightedExcessVsBenchmark: excess,
      adaptiveWeightedTopReturn: top,
      weightedTopReturn: top,
      weightedBenchmarkReturn: top - excess,
      universeMeanReturn: 0,
      topMeanReturn: top,
      benchmarkReturn: top - excess,
      scoredCount: 10,
      skippedCount: 0,
    };
  };
  const periods = ["2026-01-01:2026-03-01", "2026-02-01:2026-04-01", "2026-03-01:2026-05-01"];
  const first = walkForwardOptimize(new Map([
    ["early_winner", [makeResult(periods[0], 0.10), makeResult(periods[1], 0.08), makeResult(periods[2], -0.50)]],
    ["future_winner", [makeResult(periods[0], -0.02), makeResult(periods[1], 0.01), makeResult(periods[2], 0.50)]],
  ]), { minTrainPeriods: 2 });
  const changedCurrent = walkForwardOptimize(new Map([
    ["early_winner", [makeResult(periods[0], 0.10), makeResult(periods[1], 0.08), makeResult(periods[2], 0.50)]],
    ["future_winner", [makeResult(periods[0], -0.02), makeResult(periods[1], 0.01), makeResult(periods[2], -0.50)]],
  ]), { minTrainPeriods: 2 });

  assert.equal(first.length, 1);
  assert.equal(first[0].selectedParam, "early_winner");
  assert.equal(changedCurrent[0].selectedParam, "early_winner", "current-period outcomes must not affect current-period selection");
  assert.notEqual(first[0].adaptiveExcessVsBenchmark, changedCurrent[0].adaptiveExcessVsBenchmark);
});

test("walkForwardOptimize can require prior windows to be fully known by the current asOf", () => {
  const makeResult = (period, adaptiveReturn, excess, code) => {
    const [asOf, end] = period.split(":");
    return {
      asOf,
      end,
      top: [{ code, score: 100, recommendedWeight: 1, forwardReturn: adaptiveReturn, netForwardReturn: adaptiveReturn }],
      adaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedTopReturn: adaptiveReturn,
      netWeightedTopReturn: adaptiveReturn,
      topMeanReturn: adaptiveReturn,
      netTopMeanReturn: adaptiveReturn,
      weightedBenchmarkReturn: adaptiveReturn - excess,
      netWeightedBenchmarkReturn: adaptiveReturn - excess,
      benchmarkOverlayWeight: 0,
      adaptiveExcessVsBenchmark: excess,
      netAdaptiveExcessVsBenchmark: excess,
      weightedExcessVsBenchmark: excess,
      netWeightedExcessVsBenchmark: excess,
      adaptiveWeightedExcessReturn: excess,
      netAdaptiveWeightedExcessReturn: excess,
      universeMeanReturn: 0,
      netUniverseMeanReturn: 0,
      scoredCount: 10,
      skippedCount: 0,
    };
  };
  const periods = [
    "2026-01-01:2026-03-01",
    "2026-02-01:2026-04-01",
    "2026-03-01:2026-05-01",
    "2026-04-01:2026-06-01",
  ];
  const periodResultsByParam = new Map([
    ["overlap_winner", [
      makeResult(periods[0], 0.01, 0.01, "A"),
      makeResult(periods[1], 0.80, 0.80, "A"),
      makeResult(periods[2], 0.80, 0.80, "A"),
      makeResult(periods[3], 0.80, 0.80, "A"),
    ]],
    ["known_winner", [
      makeResult(periods[0], 0.10, 0.10, "B"),
      makeResult(periods[1], 0.10, 0.10, "B"),
      makeResult(periods[2], 0.10, 0.10, "B"),
      makeResult(periods[3], 0.10, 0.10, "B"),
    ]],
  ]);

  const leaky = walkForwardOptimize(periodResultsByParam, { minTrainPeriods: 1 });
  assert.equal(leaky[1].period, periods[2]);
  assert.equal(leaky[1].selectedParam, "overlap_winner");

  const strict = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 1,
    knownOutcomeOnly: true,
  });
  assert.equal(strict[0].period, periods[2]);
  assert.equal(strict[0].selectedParam, "known_winner");
  assert.equal(strict[0].trainingPeriods, 1);
});

test("walkForwardOptimize penalizes stale early winners with recent deterioration", () => {
  const makeResult = (period, excess, top = 0.1) => {
    const [asOf, end] = period.split(":");
    return {
      asOf,
      end,
      adaptiveExcessVsBenchmark: excess,
      weightedExcessVsBenchmark: excess,
      adaptiveWeightedTopReturn: top,
      weightedTopReturn: top,
      weightedBenchmarkReturn: top - excess,
      universeMeanReturn: 0,
      topMeanReturn: top,
      benchmarkReturn: top - excess,
      scoredCount: 10,
      skippedCount: 0,
    };
  };
  const periods = [
    "2026-01-01:2026-03-01",
    "2026-02-01:2026-04-01",
    "2026-03-01:2026-05-01",
    "2026-04-01:2026-06-01",
    "2026-05-01:2026-07-01",
  ];
  const rows = walkForwardOptimize(new Map([
    ["early_spike_recent_decay", [
      makeResult(periods[0], 0.30),
      makeResult(periods[1], 0.20),
      makeResult(periods[2], -0.10),
      makeResult(periods[3], -0.08),
      makeResult(periods[4], 0.02),
    ]],
    ["steady_recent_improver", [
      makeResult(periods[0], 0.02),
      makeResult(periods[1], 0.03),
      makeResult(periods[2], 0.04),
      makeResult(periods[3], 0.05),
      makeResult(periods[4], 0.01),
    ]],
  ]), { minTrainPeriods: 4 });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].selectedParam, "steady_recent_improver");
  assert.ok(rows[0].trainingScore > 0);
});

test("walkForwardOptimize balances absolute profit with benchmark excess", () => {
  const makeResult = (period, adaptiveReturn, excess) => {
    const [asOf, end] = period.split(":");
    return {
      asOf,
      end,
      adaptiveExcessVsBenchmark: excess,
      weightedExcessVsBenchmark: excess,
      adaptiveWeightedTopReturn: adaptiveReturn,
      weightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: adaptiveReturn - excess,
      universeMeanReturn: 0,
      topMeanReturn: adaptiveReturn,
      benchmarkReturn: adaptiveReturn - excess,
      scoredCount: 10,
      skippedCount: 0,
    };
  };
  const periods = [
    "2026-01-01:2026-03-01",
    "2026-02-01:2026-04-01",
    "2026-03-01:2026-05-01",
    "2026-04-01:2026-06-01",
  ];
  const rows = walkForwardOptimize(new Map([
    ["high_profit_positive_excess", [
      makeResult(periods[0], 0.18, 0.03),
      makeResult(periods[1], 0.20, 0.02),
      makeResult(periods[2], 0.22, 0.03),
      makeResult(periods[3], 0.12, 0.02),
    ]],
    ["low_profit_higher_excess", [
      makeResult(periods[0], 0.04, 0.06),
      makeResult(periods[1], 0.05, 0.05),
      makeResult(periods[2], 0.04, 0.06),
      makeResult(periods[3], 0.03, 0.05),
    ]],
  ]), { minTrainPeriods: 3 });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].selectedParam, "high_profit_positive_excess");
  assert.ok(rows[0].trainingAvgReturn > rows[0].trainingAvgExcess);
});

test("walkForwardOptimize can delay exploratory params until enough prior evidence exists", () => {
  const makeResult = (period, adaptiveReturn, excess) => {
    const [asOf, end] = period.split(":");
    return {
      asOf,
      end,
      adaptiveExcessVsBenchmark: excess,
      weightedExcessVsBenchmark: excess,
      adaptiveWeightedTopReturn: adaptiveReturn,
      weightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: adaptiveReturn - excess,
      universeMeanReturn: 0,
      topMeanReturn: adaptiveReturn,
      benchmarkReturn: adaptiveReturn - excess,
      scoredCount: 10,
      skippedCount: 0,
    };
  };
  const periods = [
    "2026-01-01:2026-03-01",
    "2026-02-01:2026-04-01",
    "2026-03-01:2026-05-01",
    "2026-04-01:2026-06-01",
    "2026-05-01:2026-07-01",
  ];
  const rows = walkForwardOptimize(new Map([
    ["balanced_incumbent", [
      makeResult(periods[0], 0.04, 0.02),
      makeResult(periods[1], 0.04, 0.02),
      makeResult(periods[2], 0.04, 0.02),
      makeResult(periods[3], 0.04, 0.02),
      makeResult(periods[4], 0.04, 0.02),
    ]],
    ["rank_fast_but_unproven", [
      makeResult(periods[0], 0.20, 0.12),
      makeResult(periods[1], 0.19, 0.11),
      makeResult(periods[2], -0.10, -0.12),
      makeResult(periods[3], 0.18, 0.10),
      makeResult(periods[4], 0.18, 0.10),
    ]],
  ]), {
    minTrainPeriods: 2,
    exploratoryMinTrainPeriods: 3,
    exploratoryParamPatterns: [/^rank_/],
  });

  assert.equal(rows.length, 3);
  assert.equal(rows[0].selectedParam, "balanced_incumbent");
  assert.equal(rows[0].filteredParamCount, 1);
  assert.equal(rows[1].selectedParam, "rank_fast_but_unproven");
  assert.equal(rows[1].eligibleParamCount, 2);
});

test("walkForwardOptimize keeps an incumbent unless a challenger clears the switch margin", () => {
  const makeResult = (period, adaptiveReturn, excess) => {
    const [asOf, end] = period.split(":");
    return {
      asOf,
      end,
      adaptiveExcessVsBenchmark: excess,
      weightedExcessVsBenchmark: excess,
      adaptiveWeightedTopReturn: adaptiveReturn,
      weightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: adaptiveReturn - excess,
      universeMeanReturn: 0,
      topMeanReturn: adaptiveReturn,
      benchmarkReturn: adaptiveReturn - excess,
      scoredCount: 10,
      skippedCount: 0,
    };
  };
  const periods = [
    "2026-01-01:2026-03-01",
    "2026-02-01:2026-04-01",
    "2026-03-01:2026-05-01",
    "2026-04-01:2026-06-01",
  ];
  const marginalRows = walkForwardOptimize(new Map([
    ["stable_incumbent", [
      makeResult(periods[0], 0.10, 0.05),
      makeResult(periods[1], 0.10, 0.05),
      makeResult(periods[2], 0.10, 0.05),
      makeResult(periods[3], 0.04, 0.02),
    ]],
    ["marginal_challenger", [
      makeResult(periods[0], 0.11, 0.06),
      makeResult(periods[1], 0.11, 0.06),
      makeResult(periods[2], 0.11, 0.06),
      makeResult(periods[3], 0.20, 0.12),
    ]],
  ]), {
    minTrainPeriods: 3,
    stableParamName: "stable_incumbent",
    switchMargin: 0.02,
  });
  const clearRows = walkForwardOptimize(new Map([
    ["stable_incumbent", [
      makeResult(periods[0], 0.10, 0.05),
      makeResult(periods[1], 0.10, 0.05),
      makeResult(periods[2], 0.10, 0.05),
      makeResult(periods[3], 0.04, 0.02),
    ]],
    ["clear_challenger", [
      makeResult(periods[0], 0.16, 0.11),
      makeResult(periods[1], 0.16, 0.11),
      makeResult(periods[2], 0.16, 0.11),
      makeResult(periods[3], 0.20, 0.12),
    ]],
  ]), {
    minTrainPeriods: 3,
    stableParamName: "stable_incumbent",
    switchMargin: 0.02,
  });

  assert.equal(marginalRows[0].selectedParam, "stable_incumbent");
  assert.equal(marginalRows[0].candidateParam, "marginal_challenger");
  assert.equal(marginalRows[0].selectionReason, "kept_incumbent_margin");
  assert.ok(marginalRows[0].candidateScoreAdvantage > 0);
  assert.equal(clearRows[0].selectedParam, "clear_challenger");
  assert.equal(clearRows[0].selectionReason, "switched_margin");
});

test("walkForwardOptimize can compare challengers against the stable baseline every period", () => {
  const makeResult = (period, adaptiveReturn, excess) => {
    const [asOf, end] = period.split(":");
    return {
      asOf,
      end,
      netAdaptiveExcessVsBenchmark: excess,
      weightedExcessVsBenchmark: excess,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: adaptiveReturn - excess,
      universeMeanReturn: 0,
      topMeanReturn: adaptiveReturn,
      benchmarkReturn: adaptiveReturn - excess,
      scoredCount: 10,
      skippedCount: 0,
    };
  };
  const periods = [
    "2026-01-01:2026-03-01",
    "2026-02-01:2026-04-01",
    "2026-03-01:2026-05-01",
    "2026-04-01:2026-06-01",
    "2026-05-01:2026-07-01",
  ];
  const periodResultsByParam = new Map([
    ["stable_incumbent", [
      makeResult(periods[0], 0.05, 0.03),
      makeResult(periods[1], 0.05, 0.03),
      makeResult(periods[2], 0.05, 0.03),
      makeResult(periods[3], 0.05, 0.03),
      makeResult(periods[4], 0.05, 0.03),
    ]],
    ["rank_challenger", [
      makeResult(periods[0], 0.13, 0.09),
      makeResult(periods[1], 0.13, 0.09),
      makeResult(periods[2], 0.13, 0.09),
      makeResult(periods[3], -0.05, -0.02),
      makeResult(periods[4], 0.10, 0.06),
    ]],
  ]);

  const rollingRows = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "stable_incumbent",
    switchMargin: 0.04,
  });
  const stableRows = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "stable_incumbent",
    switchMargin: 0.04,
    incumbentPolicy: "stable",
  });

  assert.equal(rollingRows.length, 2);
  assert.equal(stableRows.length, 2);
  assert.equal(rollingRows[0].selectedParam, "rank_challenger");
  assert.equal(rollingRows[1].selectedParam, "rank_challenger");
  assert.equal(rollingRows[1].incumbentParam, "rank_challenger");
  assert.equal(stableRows[0].selectedParam, "rank_challenger");
  assert.equal(stableRows[1].candidateParam, "rank_challenger");
  assert.equal(stableRows[1].incumbentParam, "stable_incumbent");
  assert.equal(stableRows[1].selectedParam, "stable_incumbent");
  assert.equal(stableRows[1].selectionReason, "kept_incumbent_margin");
  assert.ok(stableRows[1].candidateScoreAdvantage > 0);
  assert.ok(stableRows[1].candidateScoreAdvantage < 0.04);
});

test("walkForwardOptimize can block fresh challengers using only current basket quality", () => {
  const makeResult = (period, adaptiveReturn, excess, top) => {
    const [asOf, end] = period.split(":");
    return {
      asOf,
      end,
      netAdaptiveExcessVsBenchmark: excess,
      weightedExcessVsBenchmark: excess,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: adaptiveReturn - excess,
      universeMeanReturn: 0,
      topMeanReturn: adaptiveReturn,
      benchmarkReturn: adaptiveReturn - excess,
      scoredCount: 10,
      skippedCount: 0,
      top,
    };
  };
  const top = (freshTrendScore, r20, relativeMomentumScore, industryResidualR20Score) => [
    { freshTrendScore, r20, relativeMomentumScore, industryResidualR20Score },
    { freshTrendScore, r20, relativeMomentumScore, industryResidualR20Score },
  ];
  const periods = [
    "2026-01-01:2026-03-01",
    "2026-02-01:2026-04-01",
    "2026-03-01:2026-05-01",
    "2026-04-01:2026-06-01",
  ];
  const currentGate = {
    mode: "fresh-v1",
    minFreshTrendAdvantage: 0,
    minR20Advantage: -0.05,
    minRelativeMomentumAdvantage: -8,
    blockNegativeR20AndIndustryResidual: true,
  };
  const periodResultsByParam = new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.06, 0.03, top(42, 0.04, 56, 54)),
      makeResult(periods[1], 0.06, 0.03, top(42, 0.04, 56, 54)),
      makeResult(periods[2], 0.06, 0.03, top(42, 0.04, 56, 54)),
      makeResult(periods[3], 0.03, 0.01, top(58, 0.08, 62, 56)),
    ]],
    ["rank_fresh_reversal_v54", [
      makeResult(periods[0], 0.18, 0.12, top(70, 0.16, 64, 58)),
      makeResult(periods[1], 0.18, 0.12, top(70, 0.16, 64, 58)),
      makeResult(periods[2], 0.18, 0.12, top(70, 0.16, 64, 58)),
      makeResult(periods[3], 0.35, 0.30, top(74, 0.02, 50, 52)),
    ]],
  ]);

  const rows = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: currentGate,
  });
  const changedFutureRows = walkForwardOptimize(new Map([
    ["balanced_reversal_stability_v51", periodResultsByParam.get("balanced_reversal_stability_v51")],
    ["rank_fresh_reversal_v54", [
      ...periodResultsByParam.get("rank_fresh_reversal_v54").slice(0, 3),
      makeResult(periods[3], -0.35, -0.30, top(74, 0.02, 50, 52)),
    ]],
  ]), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: currentGate,
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].candidateParam, "rank_fresh_reversal_v54");
  assert.equal(rows[0].selectedParam, "balanced_reversal_stability_v51");
  assert.equal(rows[0].selectionReason, "kept_incumbent_current_gate");
  assert.equal(rows[0].currentGatePassed, false);
  assert.match(rows[0].currentGateReason, /relative_momentum/);
  assert.equal(changedFutureRows[0].selectedParam, rows[0].selectedParam);
  assert.equal(changedFutureRows[0].selectionReason, rows[0].selectionReason);
  assert.notEqual(rows[0].candidateTrainingScore, null);
});

test("walkForwardOptimize does not overblock weak fresh challengers with positive current confirmation", () => {
  const makeResult = (period, adaptiveReturn, excess, top) => {
    const [asOf, end] = period.split(":");
    return {
      asOf,
      end,
      netAdaptiveExcessVsBenchmark: excess,
      weightedExcessVsBenchmark: excess,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: adaptiveReturn - excess,
      universeMeanReturn: 0,
      topMeanReturn: adaptiveReturn,
      benchmarkReturn: adaptiveReturn - excess,
      scoredCount: 10,
      skippedCount: 0,
      top,
    };
  };
  const top = (freshTrendScore, r20, relativeMomentumScore, industryResidualMomentumScore) => [
    { freshTrendScore, r20, relativeMomentumScore, industryResidualMomentumScore },
    { freshTrendScore, r20, relativeMomentumScore, industryResidualMomentumScore },
  ];
  const periods = [
    "2026-01-01:2026-03-01",
    "2026-02-01:2026-04-01",
    "2026-03-01:2026-05-01",
    "2026-04-01:2026-06-01",
  ];
  const rows = walkForwardOptimize(new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.06, 0.03, top(50, 0.08, 58, 55)),
      makeResult(periods[1], 0.06, 0.03, top(50, 0.08, 58, 55)),
      makeResult(periods[2], 0.06, 0.03, top(50, 0.08, 58, 55)),
      makeResult(periods[3], 0.04, 0.02, top(58, 0.10, 60, 56)),
    ]],
    ["rank_fresh_reversal_v54", [
      makeResult(periods[0], 0.16, 0.10, top(70, 0.16, 66, 60)),
      makeResult(periods[1], 0.16, 0.10, top(70, 0.16, 66, 60)),
      makeResult(periods[2], 0.16, 0.10, top(70, 0.16, 66, 60)),
      makeResult(periods[3], 0.18, 0.12, top(65, 0.103, 62, 58)),
    ]],
  ]), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "fresh-v1",
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].selectedParam, "rank_fresh_reversal_v54");
  assert.equal(rows[0].selectionReason, "switched_margin");
  assert.equal(rows[0].currentGatePassed, true);
  assert.equal(rows[0].currentGateReason, "passed");
  assert.ok(rows[0].currentGateFreshTrendAdvantage < 10);
  assert.ok(rows[0].currentGateR20Advantage < 0.02);
  assert.ok(rows[0].currentGateRelativeMomentumAdvantage > 0);
  assert.ok(rows[0].currentGateIndustryResidualAdvantage > 0);
});

test("walkForwardOptimize requires material industry deterioration before blocking negative r20 fresh challengers", () => {
  const makeResult = (period, adaptiveReturn, excess, top) => {
    const [asOf, end] = period.split(":");
    return {
      asOf,
      end,
      netAdaptiveExcessVsBenchmark: excess,
      weightedExcessVsBenchmark: excess,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: adaptiveReturn - excess,
      universeMeanReturn: 0,
      topMeanReturn: adaptiveReturn,
      benchmarkReturn: adaptiveReturn - excess,
      scoredCount: 10,
      skippedCount: 0,
      top,
    };
  };
  const top = (freshTrendScore, r20, relativeMomentumScore, industryResidualMomentumScore) => [
    { freshTrendScore, r20, relativeMomentumScore, industryResidualMomentumScore },
    { freshTrendScore, r20, relativeMomentumScore, industryResidualMomentumScore },
  ];
  const periods = [
    "2026-01-01:2026-03-01",
    "2026-02-01:2026-04-01",
    "2026-03-01:2026-05-01",
    "2026-04-01:2026-06-01",
  ];
  const rows = walkForwardOptimize(new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.06, 0.03, top(50, 0.08, 60, 58)),
      makeResult(periods[1], 0.06, 0.03, top(50, 0.08, 60, 58)),
      makeResult(periods[2], 0.06, 0.03, top(50, 0.08, 60, 58)),
      makeResult(periods[3], 0.04, 0.02, top(58, 0.10, 60, 58)),
    ]],
    ["rank_fresh_reversal_v54", [
      makeResult(periods[0], 0.16, 0.10, top(70, 0.16, 66, 60)),
      makeResult(periods[1], 0.16, 0.10, top(70, 0.16, 66, 60)),
      makeResult(periods[2], 0.16, 0.10, top(70, 0.16, 66, 60)),
      makeResult(periods[3], 0.18, 0.12, top(72, 0.065, 56, 53.5)),
    ]],
  ]), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "fresh-v1",
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].selectedParam, "rank_fresh_reversal_v54");
  assert.equal(rows[0].currentGateReason, "passed");
  assert.ok(rows[0].currentGateR20Advantage < 0);
  assert.ok(rows[0].currentGateIndustryResidualAdvantage < 0);
  assert.ok(rows[0].currentGateIndustryResidualAdvantage > -5);
});

test("walkForwardOptimize can apply a current exhaustion overlay without changing the training incumbent", () => {
  const makeResult = (period, adaptiveReturn, excess, exhaustionCashWeight = 0) => {
    const [asOf, end] = period.split(":");
    return {
      asOf,
      end,
      netAdaptiveExcessVsBenchmark: excess,
      weightedExcessVsBenchmark: excess,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: adaptiveReturn - excess,
      universeMeanReturn: 0,
      topMeanReturn: adaptiveReturn,
      benchmarkReturn: adaptiveReturn - excess,
      defensiveCashWeight: exhaustionCashWeight,
      exhaustionCashWeight,
      benchmarkOverlayWeight: 0,
      scoredCount: 10,
      skippedCount: 0,
      top: [{ freshTrendScore: 55, r20: 0.12, relativeMomentumScore: 72, industryResidualMomentumScore: 75 }],
    };
  };
  const periods = [
    "2026-01-01:2026-03-01",
    "2026-02-01:2026-04-01",
    "2026-03-01:2026-05-01",
    "2026-04-01:2026-06-01",
  ];
  const periodResultsByParam = new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.08, 0.03),
      makeResult(periods[1], 0.07, 0.02),
      makeResult(periods[2], 0.06, 0.01),
      makeResult(periods[3], -0.18, -0.10),
    ]],
    ["balanced_reversal_stability_selective_exhaustion_cash_v56", [
      makeResult(periods[0], 0.079, 0.029),
      makeResult(periods[1], 0.069, 0.019),
      makeResult(periods[2], 0.059, 0.009),
      makeResult(periods[3], -0.11, -0.03, 0.18),
    ]],
  ]);

  const rows = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v1",
  });
  const changedFutureRows = walkForwardOptimize(new Map([
    ["balanced_reversal_stability_v51", periodResultsByParam.get("balanced_reversal_stability_v51").map((row, index) => (
      index === 3 ? { ...row, netAdaptiveWeightedTopReturn: 0.50, netAdaptiveExcessVsBenchmark: 0.40 } : row
    ))],
    ["balanced_reversal_stability_selective_exhaustion_cash_v56", periodResultsByParam.get("balanced_reversal_stability_selective_exhaustion_cash_v56").map((row, index) => (
      index === 3 ? { ...row, netAdaptiveWeightedTopReturn: -0.50, netAdaptiveExcessVsBenchmark: -0.40 } : row
    ))],
  ]), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v1",
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].selectedParam, "balanced_reversal_stability_selective_exhaustion_cash_v56");
  assert.equal(rows[0].selectionReason, "switched_current_exhaustion_overlay");
  assert.equal(rows[0].currentGateReason, "exhaustion_overlay_applied");
  assert.equal(changedFutureRows[0].selectedParam, rows[0].selectedParam);
  assert.equal(changedFutureRows[0].currentGateReason, rows[0].currentGateReason);
});

test("walkForwardOptimize can apply a mature momentum overlay through regime-v2", () => {
  const makeResult = (period, adaptiveReturn, excess, exhaustionCashWeight = 0) => {
    const [asOf, end] = period.split(":");
    return {
      asOf,
      end,
      netAdaptiveExcessVsBenchmark: excess,
      weightedExcessVsBenchmark: excess,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: adaptiveReturn - excess,
      universeMeanReturn: 0,
      topMeanReturn: adaptiveReturn,
      benchmarkReturn: adaptiveReturn - excess,
      defensiveCashWeight: exhaustionCashWeight,
      exhaustionCashWeight,
      benchmarkOverlayWeight: 0,
      scoredCount: 10,
      skippedCount: 0,
      top: [{
        freshTrendScore: 44,
        r20: 0.16,
        r60: 0.70,
        acceleration20vs60: -0.07,
        vol20: 0.66,
        relativeR60: 0.60,
        relativeMomentumScore: 92,
        industryResidualMomentumScore: 88,
      }],
    };
  };
  const periods = [
    "2026-01-01:2026-03-01",
    "2026-02-01:2026-04-01",
    "2026-03-01:2026-05-01",
    "2026-04-01:2026-06-01",
  ];
  const periodResultsByParam = new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.08, 0.03),
      makeResult(periods[1], 0.07, 0.02),
      makeResult(periods[2], 0.06, 0.01),
      makeResult(periods[3], -0.06, -0.11),
    ]],
    ["balanced_reversal_stability_mature_exhaustion_cash_v57", [
      makeResult(periods[0], 0.079, 0.029),
      makeResult(periods[1], 0.069, 0.019),
      makeResult(periods[2], 0.059, 0.009),
      makeResult(periods[3], -0.04, -0.09, 0.16),
    ]],
  ]);

  const rows = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v2",
  });
  const changedFutureRows = walkForwardOptimize(new Map([
    ["balanced_reversal_stability_v51", periodResultsByParam.get("balanced_reversal_stability_v51").map((row, index) => (
      index === 3 ? { ...row, netAdaptiveWeightedTopReturn: 0.50, netAdaptiveExcessVsBenchmark: 0.40 } : row
    ))],
    ["balanced_reversal_stability_mature_exhaustion_cash_v57", periodResultsByParam.get("balanced_reversal_stability_mature_exhaustion_cash_v57").map((row, index) => (
      index === 3 ? { ...row, netAdaptiveWeightedTopReturn: -0.50, netAdaptiveExcessVsBenchmark: -0.40 } : row
    ))],
  ]), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v2",
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].selectedParam, "balanced_reversal_stability_mature_exhaustion_cash_v57");
  assert.equal(rows[0].selectionReason, "switched_current_exhaustion_overlay");
  assert.equal(rows[0].currentGateReason, "exhaustion_overlay_applied");
  assert.equal(changedFutureRows[0].selectedParam, rows[0].selectedParam);
  assert.equal(changedFutureRows[0].currentGateReason, rows[0].currentGateReason);
});

test("walkForwardOptimize treats regime overlay rows as overlay-only candidates", () => {
  const makeResult = (period, adaptiveReturn, excess, exhaustionCashWeight = 0) => {
    const [asOf, end] = period.split(":");
    return {
      asOf,
      end,
      netAdaptiveExcessVsBenchmark: excess,
      weightedExcessVsBenchmark: excess,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: adaptiveReturn - excess,
      universeMeanReturn: 0,
      topMeanReturn: adaptiveReturn,
      benchmarkReturn: adaptiveReturn - excess,
      defensiveCashWeight: exhaustionCashWeight,
      exhaustionCashWeight,
      benchmarkOverlayWeight: 0,
      scoredCount: 10,
      skippedCount: 0,
      top: [{ freshTrendScore: 55, r20: 0.12, relativeMomentumScore: 80, industryResidualMomentumScore: 82 }],
    };
  };
  const periods = [
    "2026-01-01:2026-03-01",
    "2026-02-01:2026-04-01",
    "2026-03-01:2026-05-01",
    "2026-04-01:2026-06-01",
  ];
  const rows = walkForwardOptimize(new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.06, 0.03),
      makeResult(periods[1], 0.06, 0.03),
      makeResult(periods[2], 0.06, 0.03),
      makeResult(periods[3], 0.04, 0.02),
    ]],
    ["balanced_reversal_stability_mature_exhaustion_cash_v57", [
      makeResult(periods[0], 0.20, 0.16),
      makeResult(periods[1], 0.18, 0.14),
      makeResult(periods[2], 0.16, 0.12),
      makeResult(periods[3], 0.30, 0.26, 0),
    ]],
  ]), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v2",
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].selectedParam, "balanced_reversal_stability_v51");
  assert.equal(rows[0].selectionReason, "kept_incumbent_best");
});

test("walkForwardOptimize can apply a recovery beta overlay after prior benchmark underperformance", () => {
  const makeResult = (period, adaptiveReturn, excess, top, benchmarkOverlayWeight = 0) => {
    const [asOf, end] = period.split(":");
    return {
      asOf,
      end,
      netAdaptiveExcessVsBenchmark: excess,
      weightedExcessVsBenchmark: excess,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: adaptiveReturn - excess,
      universeMeanReturn: 0,
      topMeanReturn: adaptiveReturn,
      benchmarkReturn: adaptiveReturn - excess,
      defensiveCashWeight: 0,
      exhaustionCashWeight: 0,
      benchmarkOverlayWeight,
      scoredCount: 10,
      skippedCount: 0,
      top,
    };
  };
  const strongBasketLowBenchmark = [{
    freshTrendScore: 78,
    r20: 0.30,
    benchmarkR20: 0.00,
    benchmarkR60: -0.02,
    relativeR20: 0.30,
    relativeR60: 0.38,
    relativeMomentumScore: 96,
    industryResidualMomentumScore: 90,
  }];
  const normalBasket = [{
    freshTrendScore: 64,
    r20: 0.12,
    benchmarkR20: 0.04,
    benchmarkR60: 0.05,
    relativeR20: 0.08,
    relativeR60: 0.10,
    relativeMomentumScore: 82,
    industryResidualMomentumScore: 80,
  }];
  const periods = [
    "2026-01-01:2026-03-01",
    "2026-02-01:2026-04-01",
    "2026-03-01:2026-05-01",
    "2026-04-01:2026-06-01",
    "2026-05-01:2026-07-01",
  ];
  const periodResultsByParam = new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.06, 0.03, normalBasket),
      makeResult(periods[1], 0.07, 0.03, normalBasket),
      makeResult(periods[2], -0.03, -0.07, normalBasket),
      makeResult(periods[3], 0.08, -0.02, strongBasketLowBenchmark),
      makeResult(periods[4], 0.05, 0.02, normalBasket),
    ]],
    ["balanced_reversal_stability_beta_recovery_v58", [
      makeResult(periods[0], 0.059, 0.029, normalBasket, 0),
      makeResult(periods[1], 0.069, 0.029, normalBasket, 0),
      makeResult(periods[2], -0.031, -0.071, normalBasket, 0),
      makeResult(periods[3], 0.095, -0.005, strongBasketLowBenchmark, 0.22),
      makeResult(periods[4], 0.049, 0.019, normalBasket, 0),
    ]],
  ]);

  const rows = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v3",
  });
  const changedCurrentFutureRows = walkForwardOptimize(new Map([
    ["balanced_reversal_stability_v51", periodResultsByParam.get("balanced_reversal_stability_v51").map((row, index) => (
      index === 3 ? { ...row, netAdaptiveWeightedTopReturn: 0.40, netAdaptiveExcessVsBenchmark: 0.30 } : row
    ))],
    ["balanced_reversal_stability_beta_recovery_v58", periodResultsByParam.get("balanced_reversal_stability_beta_recovery_v58").map((row, index) => (
      index === 3 ? { ...row, netAdaptiveWeightedTopReturn: -0.40, netAdaptiveExcessVsBenchmark: -0.50 } : row
    ))],
  ]), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v3",
  });

  assert.equal(rows.length, 2);
  assert.equal(rows[0].selectedParam, "balanced_reversal_stability_beta_recovery_v58");
  assert.equal(rows[0].selectionReason, "switched_current_recovery_overlay");
  assert.equal(rows[0].currentGateReason, "recovery_overlay_applied");
  assert.equal(changedCurrentFutureRows[0].selectedParam, rows[0].selectedParam);
  assert.equal(changedCurrentFutureRows[0].currentGateReason, rows[0].currentGateReason);
  assert.equal(rows[1].selectedParam, "balanced_reversal_stability_v51");
});

test("walkForwardOptimize can apply a stronger recovery beta overlay through regime-v4", () => {
  const makeResult = (period, adaptiveReturn, excess, top, benchmarkOverlayWeight = 0) => {
    const [asOf, end] = period.split(":");
    const benchmarkReturn = adaptiveReturn - excess;
    return {
      asOf,
      end,
      top,
      adaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: benchmarkReturn,
      netWeightedBenchmarkReturn: benchmarkReturn,
      netAdaptiveExcessVsBenchmark: excess,
      benchmarkOverlayWeight,
    };
  };
  const recoveryBasket = [{
    freshTrendScore: 78,
    r20: 0.28,
    benchmarkR20: 0.01,
    benchmarkR60: -0.02,
    relativeR20: 0.27,
    relativeR60: 0.35,
    relativeMomentumScore: 95,
    industryResidualMomentumScore: 88,
  }];
  const attackBasketWithoutRecoveryConfirmation = [{
    ...recoveryBasket[0],
    relativeR20: 0.05,
    relativeMomentumScore: 78,
  }];
  const normalBasket = [{
    freshTrendScore: 64,
    r20: 0.12,
    benchmarkR20: 0.04,
    benchmarkR60: 0.05,
    relativeR20: 0.08,
    relativeR60: 0.10,
    relativeMomentumScore: 82,
    industryResidualMomentumScore: 80,
  }];
  const periods = [
    "2026-01-01:2026-03-01",
    "2026-02-01:2026-04-01",
    "2026-03-01:2026-05-01",
    "2026-04-01:2026-06-01",
  ];
  const periodResultsByParam = new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.06, 0.03, normalBasket),
      makeResult(periods[1], 0.07, 0.03, normalBasket),
      makeResult(periods[2], -0.03, -0.07, normalBasket),
      makeResult(periods[3], 0.08, -0.02, recoveryBasket),
    ]],
    ["balanced_reversal_stability_beta_recovery_stronger_v59", [
      makeResult(periods[0], 0.058, 0.028, normalBasket, 0),
      makeResult(periods[1], 0.068, 0.028, normalBasket, 0),
      makeResult(periods[2], -0.032, -0.072, normalBasket, 0),
      makeResult(periods[3], 0.098, -0.002, recoveryBasket, 0.31),
    ]],
  ]);

  const rows = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v4",
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].selectedParam, "balanced_reversal_stability_beta_recovery_stronger_v59");
  assert.equal(rows[0].selectionReason, "switched_current_recovery_overlay");
  assert.equal(rows[0].currentGateReason, "recovery_overlay_applied");
  assert.equal(rows[0].benchmarkOverlayWeight, 0.31);
});

test("walkForwardOptimize can restore recovery priority after benchmark-state attack weakens through regime-v8", () => {
  const makeResult = (period, adaptiveReturn, excess, top, benchmarkOverlayWeight = 0) => {
    const [asOf, end] = period.split(":");
    const benchmarkReturn = adaptiveReturn - excess;
    return {
      asOf,
      end,
      top,
      adaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: benchmarkReturn,
      netWeightedBenchmarkReturn: benchmarkReturn,
      netAdaptiveExcessVsBenchmark: excess,
      benchmarkOverlayWeight,
    };
  };
  const normalBasket = [{
    freshTrendScore: 66,
    r20: 0.12,
    benchmarkR20: 0.04,
    benchmarkR60: 0.05,
    relativeR20: 0.08,
    relativeR60: 0.10,
    relativeMomentumScore: 84,
    industryResidualMomentumScore: 82,
  }];
  const recoveryBasket = [{
    freshTrendScore: 78,
    r20: 0.28,
    benchmarkR20: 0.01,
    benchmarkR60: -0.02,
    relativeR20: 0.27,
    relativeR60: 0.35,
    relativeMomentumScore: 95,
    industryResidualMomentumScore: 88,
  }];
  const attackBasketWithoutRecoveryConfirmation = [{
    ...recoveryBasket[0],
    relativeR20: 0.05,
    relativeMomentumScore: 78,
  }];
  const periods = [
    "2026-01-01:2026-03-01",
    "2026-02-01:2026-04-01",
    "2026-03-01:2026-05-01",
    "2026-04-01:2026-06-01",
    "2026-05-01:2026-07-01",
  ];
  const periodResultsByParam = new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.05, 0.02, normalBasket),
      makeResult(periods[1], 0.04, 0.01, normalBasket),
      makeResult(periods[2], 0.03, 0.00, normalBasket),
      makeResult(periods[3], 0.02, -0.01, normalBasket),
      makeResult(periods[4], 0.07, -0.03, recoveryBasket),
    ]],
    ["rank_benchmark_state_attack_v32", [
      makeResult(periods[0], 0.07, 0.04, normalBasket),
      makeResult(periods[1], 0.06, 0.03, normalBasket),
      makeResult(periods[2], 0.05, 0.02, normalBasket),
      makeResult(periods[3], 0.06, -0.01, normalBasket),
      makeResult(periods[4], 0.08, -0.08, attackBasketWithoutRecoveryConfirmation),
    ]],
    ["balanced_reversal_stability_beta_recovery_stronger_v59", [
      makeResult(periods[0], 0.049, 0.019, normalBasket, 0),
      makeResult(periods[1], 0.039, 0.009, normalBasket, 0),
      makeResult(periods[2], 0.029, -0.001, normalBasket, 0),
      makeResult(periods[3], 0.019, -0.011, normalBasket, 0),
      makeResult(periods[4], 0.10, -0.01, recoveryBasket, 0.30),
    ]],
  ]);

  const rowsWithCurrentGate = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v7",
  });
  const rowsWithAttackRecoveryGate = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v8",
  });

  assert.equal(rowsWithCurrentGate[1].selectedParam, "rank_benchmark_state_attack_v32");
  assert.equal(rowsWithAttackRecoveryGate[1].selectedParam, "balanced_reversal_stability_beta_recovery_stronger_v59");
  assert.equal(rowsWithAttackRecoveryGate[1].selectionReason, "switched_current_recovery_overlay");
  assert.equal(rowsWithAttackRecoveryGate[1].currentGateReason, "recovery_overlay_applied");
  assert.equal(rowsWithAttackRecoveryGate[1].benchmarkOverlayWeight, 0.30);
});

test("walkForwardOptimize can block benchmark-state attack when benchmark already firms but basket residual quality lags through regime-v9", () => {
  const makeResult = (period, adaptiveReturn, excess, top) => {
    const [asOf, end] = period.split(":");
    const benchmarkReturn = adaptiveReturn - excess;
    return {
      asOf,
      end,
      top,
      adaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: benchmarkReturn,
      netWeightedBenchmarkReturn: benchmarkReturn,
      netAdaptiveExcessVsBenchmark: excess,
      benchmarkOverlayWeight: 0,
    };
  };
  const incumbentBasket = [{
    freshTrendScore: 72,
    r20: 0.24,
    benchmarkR20: 0.03,
    benchmarkR60: -0.02,
    relativeR20: 0.20,
    relativeR60: 0.44,
    relativeMomentumScore: 96,
    industryResidualMomentumScore: 92,
  }];
  const laggingAttackBasket = [{
    freshTrendScore: 76,
    r20: 0.21,
    benchmarkR20: 0.022,
    benchmarkR60: 0.00,
    relativeR20: 0.19,
    relativeR60: 0.27,
    relativeMomentumScore: 92,
    industryResidualMomentumScore: 72,
  }];
  const periods = [
    "2026-01-01:2026-03-01",
    "2026-02-01:2026-04-01",
    "2026-03-01:2026-05-01",
    "2026-04-01:2026-06-01",
  ];
  const periodResultsByParam = new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.04, 0.01, incumbentBasket),
      makeResult(periods[1], 0.03, 0.01, incumbentBasket),
      makeResult(periods[2], 0.02, 0.00, incumbentBasket),
      makeResult(periods[3], 0.06, 0.05, incumbentBasket),
    ]],
    ["rank_benchmark_state_attack_v32", [
      makeResult(periods[0], 0.07, 0.04, laggingAttackBasket),
      makeResult(periods[1], 0.06, 0.04, laggingAttackBasket),
      makeResult(periods[2], 0.05, 0.03, laggingAttackBasket),
      makeResult(periods[3], 0.03, 0.03, laggingAttackBasket),
    ]],
  ]);

  const rowsWithV8 = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v8",
  });
  const rowsWithV9 = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v9",
  });

  assert.equal(rowsWithV8[0].selectedParam, "rank_benchmark_state_attack_v32");
  assert.equal(rowsWithV9[0].selectedParam, "balanced_reversal_stability_v51");
  assert.equal(rowsWithV9[0].selectionReason, "kept_incumbent_current_gate");
  assert.equal(rowsWithV9[0].currentGateReason, "attack_benchmark_positive_industry_residual_advantage_below_min");
});

test("walkForwardOptimize preserves recovery overlay before benchmark-state attack quality blocks through regime-v10", () => {
  const makeResult = (period, adaptiveReturn, excess, top, benchmarkOverlayWeight = 0) => {
    const [asOf, end] = period.split(":");
    const benchmarkReturn = adaptiveReturn - excess;
    return {
      asOf,
      end,
      top,
      adaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: benchmarkReturn,
      netWeightedBenchmarkReturn: benchmarkReturn,
      netAdaptiveExcessVsBenchmark: excess,
      benchmarkOverlayWeight,
    };
  };
  const incumbentBasket = [{
    freshTrendScore: 76,
    r20: 0.31,
    benchmarkR20: 0.01,
    benchmarkR60: -0.02,
    relativeR20: 0.31,
    relativeR60: 0.39,
    relativeMomentumScore: 96,
    industryResidualMomentumScore: 90,
  }];
  const laggingAttackBasket = [{
    freshTrendScore: 70,
    r20: 0.21,
    benchmarkR20: 0.026,
    benchmarkR60: 0.00,
    relativeR20: 0.19,
    relativeR60: 0.29,
    relativeMomentumScore: 88,
    industryResidualMomentumScore: 78,
  }];
  const recoveryBasket = [{
    freshTrendScore: 78,
    r20: 0.26,
    benchmarkR20: 0.01,
    benchmarkR60: -0.02,
    relativeR20: 0.27,
    relativeR60: 0.35,
    relativeMomentumScore: 95,
    industryResidualMomentumScore: 88,
  }];
  const periods = [
    "2026-01-01:2026-03-01",
    "2026-02-01:2026-04-01",
    "2026-03-01:2026-05-01",
    "2026-04-01:2026-06-01",
    "2026-05-01:2026-07-01",
  ];
  const periodResultsByParam = new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.05, 0.02, incumbentBasket),
      makeResult(periods[1], 0.04, 0.01, incumbentBasket),
      makeResult(periods[2], 0.03, 0.00, incumbentBasket),
      makeResult(periods[3], 0.02, -0.01, incumbentBasket),
      makeResult(periods[4], 0.07, -0.03, incumbentBasket),
    ]],
    ["rank_benchmark_state_attack_v32", [
      makeResult(periods[0], 0.07, 0.04, laggingAttackBasket),
      makeResult(periods[1], 0.06, 0.03, laggingAttackBasket),
      makeResult(periods[2], 0.05, 0.02, laggingAttackBasket),
      makeResult(periods[3], 0.06, -0.01, laggingAttackBasket),
      makeResult(periods[4], 0.08, -0.02, laggingAttackBasket),
    ]],
    ["balanced_reversal_stability_beta_recovery_stronger_v59", [
      makeResult(periods[0], 0.049, 0.019, recoveryBasket, 0),
      makeResult(periods[1], 0.039, 0.009, recoveryBasket, 0),
      makeResult(periods[2], 0.029, -0.001, recoveryBasket, 0),
      makeResult(periods[3], 0.019, -0.011, recoveryBasket, 0),
      makeResult(periods[4], 0.10, -0.01, recoveryBasket, 0.30),
    ]],
  ]);

  const rowsWithV9 = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v9",
  });
  const rowsWithV10 = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v10",
  });

  assert.equal(rowsWithV9[1].selectedParam, "balanced_reversal_stability_v51");
  assert.equal(rowsWithV9[1].currentGateReason, "attack_benchmark_positive_industry_residual_advantage_below_min");
  assert.equal(rowsWithV10[1].selectedParam, "balanced_reversal_stability_beta_recovery_stronger_v59");
  assert.equal(rowsWithV10[1].selectionReason, "switched_current_recovery_overlay");
  assert.equal(rowsWithV10[1].currentGateReason, "recovery_overlay_applied");
});

test("walkForwardOptimize can rotate to fresh reversal before mature beta exhaustion through regime-v11", () => {
  const makeResult = (period, adaptiveReturn, excess, top, benchmarkOverlayWeight = 0, exhaustionCashWeight = 0) => {
    const [asOf, end] = period.split(":");
    const benchmarkReturn = adaptiveReturn - excess;
    return {
      asOf,
      end,
      top,
      adaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: benchmarkReturn,
      netWeightedBenchmarkReturn: benchmarkReturn,
      netAdaptiveExcessVsBenchmark: excess,
      benchmarkOverlayWeight,
      exhaustionCashWeight,
    };
  };
  const incumbentBasket = [{
    freshTrendScore: 66,
    r20: 0.20,
    benchmarkR20: 0.08,
    benchmarkR60: 0.27,
    relativeMomentumScore: 78,
    industryResidualMomentumScore: 86,
  }];
  const freshRotationBasket = [{
    freshTrendScore: 78,
    r20: 0.30,
    benchmarkR20: 0.10,
    benchmarkR60: 0.32,
    relativeMomentumScore: 84,
    industryResidualMomentumScore: 73,
  }];
  const matureOverlayBasket = [{
    freshTrendScore: 65,
    r20: 0.20,
    benchmarkR20: 0.08,
    benchmarkR60: 0.27,
    relativeMomentumScore: 78,
    industryResidualMomentumScore: 86,
  }];
  const periods = [
    "2025-07-01:2025-09-01",
    "2025-08-01:2025-10-01",
    "2025-09-01:2025-11-01",
    "2025-10-01:2025-12-01",
  ];
  const periodResultsByParam = new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.08, 0.03, incumbentBasket),
      makeResult(periods[1], 0.06, 0.02, incumbentBasket),
      makeResult(periods[2], 0.04, 0.01, incumbentBasket),
      makeResult(periods[3], -0.08, -0.04, incumbentBasket),
    ]],
    ["rank_fresh_reversal_v54", [
      makeResult(periods[0], 0.04, 0.01, freshRotationBasket),
      makeResult(periods[1], 0.03, 0.00, freshRotationBasket),
      makeResult(periods[2], 0.02, -0.01, freshRotationBasket),
      makeResult(periods[3], -0.06, -0.01, freshRotationBasket),
    ]],
    ["balanced_reversal_stability_mature_beta_rotation_stronger_v63", [
      makeResult(periods[0], 0.079, 0.029, matureOverlayBasket, 0, 0),
      makeResult(periods[1], 0.059, 0.019, matureOverlayBasket, 0, 0),
      makeResult(periods[2], 0.039, 0.009, matureOverlayBasket, 0, 0),
      makeResult(periods[3], -0.07, -0.03, matureOverlayBasket, 0.26, 0.24),
    ]],
  ]);

  const rowsWithV10 = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v10",
  });
  const rowsWithV11 = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v11",
  });

  assert.equal(rowsWithV10[0].selectedParam, "balanced_reversal_stability_mature_beta_rotation_stronger_v63");
  assert.equal(rowsWithV10[0].selectionReason, "switched_current_exhaustion_overlay");
  assert.equal(rowsWithV11[0].selectedParam, "rank_fresh_reversal_v54");
  assert.equal(rowsWithV11[0].selectionReason, "switched_current_fresh_rotation_overlay");
  assert.equal(rowsWithV11[0].currentGateReason, "fresh_rotation_overlay_applied");
  assert.ok(rowsWithV11[0].currentGateFreshTrendAdvantage >= 8);
});

test("walkForwardOptimize can use a lottery-spike guard only after fresh rotation through regime-v12", () => {
  const makeResult = (period, adaptiveReturn, excess, top, benchmarkOverlayWeight = 0, exhaustionCashWeight = 0) => {
    const [asOf, end] = period.split(":");
    const benchmarkReturn = adaptiveReturn - excess;
    return {
      asOf,
      end,
      top,
      adaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: benchmarkReturn,
      netWeightedBenchmarkReturn: benchmarkReturn,
      netAdaptiveExcessVsBenchmark: excess,
      benchmarkOverlayWeight,
      exhaustionCashWeight,
    };
  };
  const incumbentBasket = [{
    freshTrendScore: 66,
    r20: 0.20,
    benchmarkR20: 0.08,
    benchmarkR60: 0.27,
    relativeMomentumScore: 78,
    industryResidualMomentumScore: 86,
  }];
  const freshRotationBasket = [{
    freshTrendScore: 78,
    r20: 0.30,
    benchmarkR20: 0.10,
    benchmarkR60: 0.32,
    relativeMomentumScore: 84,
    industryResidualMomentumScore: 73,
    lotterySpikeScore: 93,
  }];
  const lotteryGuardBasket = [{
    freshTrendScore: 77,
    r20: 0.27,
    benchmarkR20: 0.10,
    benchmarkR60: 0.32,
    relativeMomentumScore: 82,
    industryResidualMomentumScore: 74,
    lotterySpikeScore: 98.4,
  }];
  const overheatedLotteryGuardBasket = [{
    ...lotteryGuardBasket[0],
    freshTrendScore: 85,
    lotterySpikeScore: 98.8,
  }];
  const matureOverlayBasket = [{
    freshTrendScore: 65,
    r20: 0.20,
    benchmarkR20: 0.08,
    benchmarkR60: 0.27,
    relativeMomentumScore: 78,
    industryResidualMomentumScore: 86,
  }];
  const periods = [
    "2025-07-01:2025-09-01",
    "2025-08-01:2025-10-01",
    "2025-09-01:2025-11-01",
    "2025-10-01:2025-12-01",
  ];
  const periodResultsByParam = new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.08, 0.03, incumbentBasket),
      makeResult(periods[1], 0.06, 0.02, incumbentBasket),
      makeResult(periods[2], 0.04, 0.01, incumbentBasket),
      makeResult(periods[3], -0.08, -0.04, incumbentBasket),
    ]],
    ["rank_fresh_reversal_v54", [
      makeResult(periods[0], 0.04, 0.01, freshRotationBasket),
      makeResult(periods[1], 0.03, 0.00, freshRotationBasket),
      makeResult(periods[2], 0.02, -0.01, freshRotationBasket),
      makeResult(periods[3], -0.06, -0.01, freshRotationBasket),
    ]],
    ["rank_fresh_reversal_lottery_guard_v64", [
      makeResult(periods[0], 0.20, 0.16, lotteryGuardBasket),
      makeResult(periods[1], 0.18, 0.14, lotteryGuardBasket),
      makeResult(periods[2], 0.16, 0.12, lotteryGuardBasket),
      makeResult(periods[3], -0.05, 0.00, lotteryGuardBasket),
    ]],
    ["balanced_reversal_stability_mature_beta_rotation_stronger_v63", [
      makeResult(periods[0], 0.079, 0.029, matureOverlayBasket, 0, 0),
      makeResult(periods[1], 0.059, 0.019, matureOverlayBasket, 0, 0),
      makeResult(periods[2], 0.039, 0.009, matureOverlayBasket, 0, 0),
      makeResult(periods[3], -0.07, -0.03, matureOverlayBasket, 0.26, 0.24),
    ]],
  ]);

  const rowsWithV12 = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v12",
  });

  assert.equal(rowsWithV12[0].selectedParam, "rank_fresh_reversal_lottery_guard_v64");
  assert.equal(rowsWithV12[0].selectionReason, "switched_current_fresh_rotation_lottery_guard_overlay");
  assert.equal(rowsWithV12[0].currentGateReason, "fresh_rotation_lottery_guard_overlay_applied");
  assert.equal(rowsWithV12[0].candidateParam, "balanced_reversal_stability_v51");
  assert.equal(rowsWithV12[0].filteredParamCount, 2);
  assert.equal(rowsWithV12[0].currentGateLotteryGuardScore, 98.4);
  assert.equal(rowsWithV12[0].currentGateLotteryGuardFreshTrend, 77);

  const rowsWithV13 = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v13",
  });

  assert.equal(rowsWithV13[0].selectedParam, "rank_fresh_reversal_lottery_guard_v64");
  assert.equal(rowsWithV13[0].selectionReason, "switched_current_fresh_rotation_lottery_guard_overlay");
  assert.equal(rowsWithV13[0].currentGateReason, "fresh_rotation_lottery_guard_overlay_applied");
  assert.equal(rowsWithV13[0].currentGateLotteryGuardScore, 98.4);
  assert.equal(rowsWithV13[0].currentGateLotteryGuardFreshTrend, 77);

  periodResultsByParam.set("rank_fresh_reversal_lottery_guard_v64", [
    makeResult(periods[0], 0.20, 0.16, overheatedLotteryGuardBasket),
    makeResult(periods[1], 0.18, 0.14, overheatedLotteryGuardBasket),
    makeResult(periods[2], 0.16, 0.12, overheatedLotteryGuardBasket),
    makeResult(periods[3], -0.05, 0.00, overheatedLotteryGuardBasket),
  ]);
  const rowsWithOverheatedGuard = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v12",
  });

  assert.equal(rowsWithOverheatedGuard[0].selectedParam, "rank_fresh_reversal_v54");
  assert.equal(rowsWithOverheatedGuard[0].selectionReason, "switched_current_fresh_rotation_overlay");
  assert.equal(rowsWithOverheatedGuard[0].currentGateReason, "fresh_rotation_overlay_applied");
});

test("walkForwardOptimize can attack benchmark pullbacks with relative-strength leaders through regime-v13", () => {
  const makeResult = (period, adaptiveReturn, excess, top) => {
    const [asOf, end] = period.split(":");
    const benchmarkReturn = adaptiveReturn - excess;
    return {
      asOf,
      end,
      top,
      adaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: benchmarkReturn,
      netWeightedBenchmarkReturn: benchmarkReturn,
      netAdaptiveExcessVsBenchmark: excess,
      benchmarkOverlayWeight: 0,
    };
  };
  const incumbentBasket = [{
    benchmarkR20: -0.015,
    benchmarkR60: 0.06,
    relativeR20: 0.11,
    relativeMomentumScore: 75,
    freshTrendScore: 58,
    industryResidualMomentumScore: 82,
  }];
  const benchmarkPullbackAttackBasket = [{
    benchmarkR20: -0.045,
    benchmarkR60: 0.09,
    relativeR20: 0.21,
    relativeMomentumScore: 90,
    freshTrendScore: 52,
    industryResidualMomentumScore: 88,
  }];
  const shallowPullbackAttackBasket = [{
    ...benchmarkPullbackAttackBasket[0],
    benchmarkR20: -0.012,
  }];
  const periods = [
    "2025-07-01:2025-09-01",
    "2025-08-01:2025-10-01",
    "2025-09-01:2025-11-01",
    "2025-10-01:2025-12-01",
  ];
  const periodResultsByParam = new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.09, 0.04, incumbentBasket),
      makeResult(periods[1], 0.08, 0.03, incumbentBasket),
      makeResult(periods[2], 0.07, 0.02, incumbentBasket),
      makeResult(periods[3], -0.03, 0.01, incumbentBasket),
    ]],
    ["rank_benchmark_state_attack_v32", [
      makeResult(periods[0], 0.03, 0.01, benchmarkPullbackAttackBasket),
      makeResult(periods[1], 0.02, 0.00, benchmarkPullbackAttackBasket),
      makeResult(periods[2], 0.01, -0.01, benchmarkPullbackAttackBasket),
      makeResult(periods[3], 0.04, 0.08, benchmarkPullbackAttackBasket),
    ]],
  ]);

  const rowsWithV12 = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v12",
  });
  const rowsWithV13 = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v13",
  });

  assert.equal(rowsWithV12[0].selectedParam, "balanced_reversal_stability_v51");
  assert.equal(rowsWithV13[0].selectedParam, "rank_benchmark_state_attack_v32");
  assert.equal(rowsWithV13[0].selectionReason, "switched_current_benchmark_pullback_attack_overlay");
  assert.equal(rowsWithV13[0].currentGateReason, "benchmark_pullback_attack_overlay_applied");
  assert.equal(rowsWithV13[0].currentGateBenchmarkR20, -0.045);
  assert.equal(rowsWithV13[0].currentGateRelativeR20, 0.21);

  periodResultsByParam.set("rank_benchmark_state_attack_v32", [
    makeResult(periods[0], 0.03, 0.01, shallowPullbackAttackBasket),
    makeResult(periods[1], 0.02, 0.00, shallowPullbackAttackBasket),
    makeResult(periods[2], 0.01, -0.01, shallowPullbackAttackBasket),
    makeResult(periods[3], 0.04, 0.08, shallowPullbackAttackBasket),
  ]);
  const rowsWithShallowPullback = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v13",
  });

  assert.equal(rowsWithShallowPullback[0].selectedParam, "balanced_reversal_stability_v51");
  assert.equal(rowsWithShallowPullback[0].selectionReason, "kept_incumbent_best");
});

test("walkForwardOptimize can fall back from overextended fresh reversal to mature beta through regime-v14", () => {
  const makeResult = (period, adaptiveReturn, excess, top) => {
    const [asOf, end] = period.split(":");
    const benchmarkReturn = adaptiveReturn - excess;
    return {
      asOf,
      end,
      top,
      adaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: benchmarkReturn,
      netWeightedBenchmarkReturn: benchmarkReturn,
      netAdaptiveExcessVsBenchmark: excess,
      benchmarkOverlayWeight: 0,
    };
  };
  const incumbentBasket = [{
    r20: 0.08,
    freshTrendScore: 55,
    relativeMomentumScore: 72,
    industryResidualMomentumScore: 81,
  }];
  const overextendedFreshBasket = [{
    r20: 0.15,
    freshTrendScore: 75,
    relativeMomentumScore: 76,
    industryResidualMomentumScore: 84,
  }];
  const highResidualFreshBasket = [{
    ...overextendedFreshBasket[0],
    industryResidualMomentumScore: 93,
  }];
  const matureFallbackBasket = [{
    r20: 0.09,
    freshTrendScore: 58,
    relativeMomentumScore: 74,
    industryResidualMomentumScore: 82,
  }];
  const periods = [
    "2025-04-01:2025-06-01",
    "2025-05-01:2025-07-01",
    "2025-06-01:2025-08-01",
    "2025-07-01:2025-09-01",
  ];
  const periodResultsByParam = new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.04, 0.01, incumbentBasket),
      makeResult(periods[1], 0.03, 0.01, incumbentBasket),
      makeResult(periods[2], 0.02, 0.00, incumbentBasket),
      makeResult(periods[3], 0.04, 0.01, incumbentBasket),
    ]],
    ["rank_fresh_reversal_v54", [
      makeResult(periods[0], 0.12, 0.08, overextendedFreshBasket),
      makeResult(periods[1], 0.10, 0.07, overextendedFreshBasket),
      makeResult(periods[2], 0.08, 0.05, overextendedFreshBasket),
      makeResult(periods[3], 0.01, -0.01, overextendedFreshBasket),
    ]],
    ["balanced_reversal_stability_mature_beta_rotation_stronger_v63", [
      makeResult(periods[0], 0.03, 0.00, matureFallbackBasket),
      makeResult(periods[1], 0.02, 0.00, matureFallbackBasket),
      makeResult(periods[2], 0.01, -0.01, matureFallbackBasket),
      makeResult(periods[3], 0.07, 0.05, matureFallbackBasket),
    ]],
  ]);

  const rowsWithV13 = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v13",
  });
  const rowsWithV14 = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v14",
  });

  assert.equal(rowsWithV13[0].selectedParam, "rank_fresh_reversal_v54");
  assert.equal(rowsWithV14[0].selectedParam, "balanced_reversal_stability_mature_beta_rotation_stronger_v63");
  assert.equal(rowsWithV14[0].selectionReason, "switched_current_fresh_overextension_mature_fallback_overlay");
  assert.equal(rowsWithV14[0].currentGateReason, "fresh_overextension_mature_fallback_overlay_applied");
  assert.equal(rowsWithV14[0].currentGateFreshTrendAdvantage, 20);
  assert.ok(Math.abs(rowsWithV14[0].currentGateR20Advantage - 0.07) < 1e-10);

  periodResultsByParam.set("rank_fresh_reversal_v54", [
    makeResult(periods[0], 0.12, 0.08, highResidualFreshBasket),
    makeResult(periods[1], 0.10, 0.07, highResidualFreshBasket),
    makeResult(periods[2], 0.08, 0.05, highResidualFreshBasket),
    makeResult(periods[3], 0.01, -0.01, highResidualFreshBasket),
  ]);
  const rowsWithHighResidual = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v14",
  });

  assert.equal(rowsWithHighResidual[0].selectedParam, "rank_fresh_reversal_v54");
  assert.equal(rowsWithHighResidual[0].selectionReason, "switched_margin");
});

test("walkForwardOptimize can rotate weak-index mature fallback into stable reversal through regime-v27", () => {
  const makeResult = (period, adaptiveReturn, excess, top) => {
    const [asOf, end] = period.split(":");
    const benchmarkReturn = adaptiveReturn - excess;
    return {
      asOf,
      end,
      top,
      adaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: benchmarkReturn,
      netWeightedBenchmarkReturn: benchmarkReturn,
      netAdaptiveExcessVsBenchmark: excess,
      benchmarkOverlayWeight: 0,
    };
  };
  const incumbentBasket = [{
    r20: 0.08,
    freshTrendScore: 55,
    relativeMomentumScore: 72,
    industryResidualMomentumScore: 81,
  }];
  const overextendedFreshBasket = [{
    r20: 0.16,
    freshTrendScore: 78,
    relativeMomentumScore: 76,
    industryResidualMomentumScore: 84,
  }];
  const matureFallbackBasket = [{
    r20: 0.10,
    freshTrendScore: 58,
    relativeMomentumScore: 74,
    industryResidualMomentumScore: 82,
  }];
  const weakIndexStableReversalBasket = [{
    benchmarkR20: 0.006,
    benchmarkR60: -0.05,
    r20: 0.16,
    relativeR20: 0.155,
    relativeMomentumScore: 82,
    industryResidualRankScore: 72,
    freshTrendScore: 56,
    shortTermReversalScore: 66.5,
    turnoverStabilityScore: 72,
    lotterySpikeScore: 99,
    entryDayReturn: 0.012,
    maxDailyReturn20: 0.055,
    vol20: 0.38,
    volumeMomentumScore: 50,
    volumeTurnoverRatio5v20: 1.0,
  }];
  const hotIndexStableReversalBasket = [{
    ...weakIndexStableReversalBasket[0],
    benchmarkR60: 0.18,
  }];
  const periods = [
    "2025-04-01:2025-06-01",
    "2025-05-01:2025-07-01",
    "2025-06-01:2025-08-01",
    "2025-07-01:2025-09-01",
  ];
  const periodResultsByParam = new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.04, 0.01, incumbentBasket),
      makeResult(periods[1], 0.03, 0.01, incumbentBasket),
      makeResult(periods[2], 0.02, 0.00, incumbentBasket),
      makeResult(periods[3], 0.04, 0.01, incumbentBasket),
    ]],
    ["rank_fresh_reversal_v54", [
      makeResult(periods[0], 0.12, 0.08, overextendedFreshBasket),
      makeResult(periods[1], 0.10, 0.07, overextendedFreshBasket),
      makeResult(periods[2], 0.08, 0.05, overextendedFreshBasket),
      makeResult(periods[3], 0.01, -0.01, overextendedFreshBasket),
    ]],
    ["balanced_reversal_stability_mature_beta_rotation_stronger_v63", [
      makeResult(periods[0], 0.03, 0.00, matureFallbackBasket),
      makeResult(periods[1], 0.02, 0.00, matureFallbackBasket),
      makeResult(periods[2], 0.01, -0.01, matureFallbackBasket),
      makeResult(periods[3], 0.07, 0.05, matureFallbackBasket),
    ]],
    ["rank_reversal_stability_v52", [
      makeResult(periods[0], 0.02, 0.00, weakIndexStableReversalBasket),
      makeResult(periods[1], 0.02, 0.00, weakIndexStableReversalBasket),
      makeResult(periods[2], 0.01, -0.01, weakIndexStableReversalBasket),
      makeResult(periods[3], 0.10, 0.07, weakIndexStableReversalBasket),
    ]],
  ]);

  const rowsWithV26 = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v26",
  });
  const rowsWithV27 = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v27",
  });

  assert.equal(rowsWithV26[0].selectedParam, "balanced_reversal_stability_mature_beta_rotation_stronger_v63");
  assert.equal(rowsWithV26[0].selectionReason, "switched_current_fresh_overextension_mature_fallback_overlay");
  assert.equal(rowsWithV27[0].selectedParam, "rank_reversal_stability_v52");
  assert.equal(rowsWithV27[0].selectionReason, "switched_current_fresh_overextension_reversal_stability_overlay");
  assert.equal(rowsWithV27[0].currentGateReason, "fresh_overextension_reversal_stability_overlay_applied");

  periodResultsByParam.set("rank_reversal_stability_v52", [
    makeResult(periods[0], 0.02, 0.00, hotIndexStableReversalBasket),
    makeResult(periods[1], 0.02, 0.00, hotIndexStableReversalBasket),
    makeResult(periods[2], 0.01, -0.01, hotIndexStableReversalBasket),
    makeResult(periods[3], 0.10, 0.07, hotIndexStableReversalBasket),
  ]);
  const rowsWithHotIndex = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v27",
  });

  assert.equal(rowsWithHotIndex[0].selectedParam, "balanced_reversal_stability_mature_beta_rotation_stronger_v63");
  assert.equal(rowsWithHotIndex[0].selectionReason, "switched_current_fresh_overextension_mature_fallback_overlay");
});

test("walkForwardOptimize can rotate to moderate fresh residual continuation through regime-v15", () => {
  const makeResult = (period, adaptiveReturn, excess, top) => {
    const [asOf, end] = period.split(":");
    const benchmarkReturn = adaptiveReturn - excess;
    return {
      asOf,
      end,
      top,
      adaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: benchmarkReturn,
      netWeightedBenchmarkReturn: benchmarkReturn,
      netAdaptiveExcessVsBenchmark: excess,
      benchmarkOverlayWeight: 0,
    };
  };
  const incumbentBasket = [{
    r20: 0.10,
    freshTrendScore: 60,
    relativeR20: 0.12,
    relativeMomentumScore: 80,
    industryResidualMomentumScore: 82,
    benchmarkR20: 0.01,
    benchmarkR60: 0.18,
  }];
  const moderateFreshResidualBasket = [{
    r20: 0.28,
    freshTrendScore: 70,
    relativeR20: 0.27,
    relativeMomentumScore: 89,
    industryResidualMomentumScore: 96,
    benchmarkR20: 0.015,
    benchmarkR60: 0.22,
  }];
  const overheatedBenchmarkBasket = [{
    ...moderateFreshResidualBasket[0],
    benchmarkR20: 0.08,
  }];
  const periods = [
    "2025-08-01:2025-10-01",
    "2025-09-01:2025-11-01",
    "2025-10-01:2025-12-01",
    "2025-11-01:2026-01-01",
  ];
  const periodResultsByParam = new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.06, 0.03, incumbentBasket),
      makeResult(periods[1], 0.05, 0.02, incumbentBasket),
      makeResult(periods[2], 0.04, 0.01, incumbentBasket),
      makeResult(periods[3], 0.06, 0.03, incumbentBasket),
    ]],
    ["rank_fresh_reversal_v54", [
      makeResult(periods[0], 0.02, 0.00, moderateFreshResidualBasket),
      makeResult(periods[1], 0.01, -0.01, moderateFreshResidualBasket),
      makeResult(periods[2], 0.00, -0.02, moderateFreshResidualBasket),
      makeResult(periods[3], 0.15, 0.10, moderateFreshResidualBasket),
    ]],
  ]);

  const rowsWithV14 = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v14",
  });
  const rowsWithV15 = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v15",
  });

  assert.equal(rowsWithV14[0].selectedParam, "balanced_reversal_stability_v51");
  assert.equal(rowsWithV15[0].selectedParam, "rank_fresh_reversal_v54");
  assert.equal(rowsWithV15[0].selectionReason, "switched_current_fresh_residual_continuation_overlay");
  assert.equal(rowsWithV15[0].currentGateReason, "fresh_residual_continuation_overlay_applied");
  assert.equal(rowsWithV15[0].currentGateBenchmarkR20, 0.015);
  assert.equal(rowsWithV15[0].currentGateRelativeR20, 0.27);
  assert.equal(rowsWithV15[0].currentGateFreshTrendAdvantage, 10);

  periodResultsByParam.set("rank_fresh_reversal_v54", [
    makeResult(periods[0], 0.02, 0.00, overheatedBenchmarkBasket),
    makeResult(periods[1], 0.01, -0.01, overheatedBenchmarkBasket),
    makeResult(periods[2], 0.00, -0.02, overheatedBenchmarkBasket),
    makeResult(periods[3], 0.15, 0.10, overheatedBenchmarkBasket),
  ]);
  const rowsWithOverheatedBenchmark = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v15",
  });

  assert.equal(rowsWithOverheatedBenchmark[0].selectedParam, "balanced_reversal_stability_v51");
  assert.equal(rowsWithOverheatedBenchmark[0].selectionReason, "kept_incumbent_best");
});

test("walkForwardOptimize can attack broad benchmark melt-ups through regime-v16", () => {
  const makeResult = (period, adaptiveReturn, excess, top) => {
    const [asOf, end] = period.split(":");
    const benchmarkReturn = adaptiveReturn - excess;
    return {
      asOf,
      end,
      top,
      adaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: benchmarkReturn,
      netWeightedBenchmarkReturn: benchmarkReturn,
      netAdaptiveExcessVsBenchmark: excess,
      benchmarkOverlayWeight: 0,
    };
  };
  const incumbentBasket = [{
    benchmarkR20: 0.18,
    benchmarkR60: 0.38,
    relativeR20: 0.06,
    relativeMomentumScore: 64,
    freshTrendScore: 64,
    industryResidualMomentumScore: 92,
    lotterySpikeScore: 92,
  }];
  const broadMeltupAttackBasket = [{
    benchmarkR20: 0.26,
    benchmarkR60: 0.43,
    relativeR20: 0.11,
    relativeMomentumScore: 73,
    freshTrendScore: 69,
    industryResidualMomentumScore: 99,
    industryResidualRankScore: 86,
    lotterySpikeScore: 84,
  }];
  const crowdedAttackBasket = [{
    ...broadMeltupAttackBasket[0],
    industryResidualRankScore: 94,
  }];
  const weakRelativeAttackBasket = [{
    ...broadMeltupAttackBasket[0],
    relativeR20: 0.07,
  }];
  const periods = [
    "2025-06-01:2025-08-01",
    "2025-07-01:2025-09-01",
    "2025-08-01:2025-10-01",
    "2025-09-01:2025-11-01",
  ];
  const periodResultsByParam = new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.08, 0.04, incumbentBasket),
      makeResult(periods[1], 0.07, 0.03, incumbentBasket),
      makeResult(periods[2], 0.06, 0.02, incumbentBasket),
      makeResult(periods[3], 0.09, 0.01, incumbentBasket),
    ]],
    ["rank_benchmark_state_attack_v32", [
      makeResult(periods[0], 0.01, -0.02, broadMeltupAttackBasket),
      makeResult(periods[1], 0.02, -0.01, broadMeltupAttackBasket),
      makeResult(periods[2], 0.01, -0.03, broadMeltupAttackBasket),
      makeResult(periods[3], 0.24, 0.16, broadMeltupAttackBasket),
    ]],
  ]);

  const rowsWithV15 = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v15",
  });
  const rowsWithV16 = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v16",
  });

  assert.equal(rowsWithV15[0].selectedParam, "balanced_reversal_stability_v51");
  assert.equal(rowsWithV16[0].selectedParam, "rank_benchmark_state_attack_v32");
  assert.equal(rowsWithV16[0].selectionReason, "switched_current_benchmark_meltup_broad_attack_overlay");
  assert.equal(rowsWithV16[0].currentGateReason, "benchmark_meltup_broad_attack_overlay_applied");
  assert.equal(rowsWithV16[0].currentGateBenchmarkR20, 0.26);
  assert.equal(rowsWithV16[0].currentGateBenchmarkR60, 0.43);
  assert.equal(rowsWithV16[0].currentGateRelativeR20, 0.11);
  assert.equal(rowsWithV16[0].currentGateRelativeMomentum, 73);
  assert.equal(rowsWithV16[0].currentGateIndustryResidualRankScore, 86);

  periodResultsByParam.set("rank_benchmark_state_attack_v32", [
    makeResult(periods[0], 0.01, -0.02, crowdedAttackBasket),
    makeResult(periods[1], 0.02, -0.01, crowdedAttackBasket),
    makeResult(periods[2], 0.01, -0.03, crowdedAttackBasket),
    makeResult(periods[3], 0.24, 0.16, crowdedAttackBasket),
  ]);
  const rowsWithCrowding = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v16",
  });
  assert.equal(rowsWithCrowding[0].selectedParam, "balanced_reversal_stability_v51");
  assert.equal(rowsWithCrowding[0].selectionReason, "kept_incumbent_best");

  periodResultsByParam.set("rank_benchmark_state_attack_v32", [
    makeResult(periods[0], 0.01, -0.02, weakRelativeAttackBasket),
    makeResult(periods[1], 0.02, -0.01, weakRelativeAttackBasket),
    makeResult(periods[2], 0.01, -0.03, weakRelativeAttackBasket),
    makeResult(periods[3], 0.24, 0.16, weakRelativeAttackBasket),
  ]);
  const rowsWithWeakRelative = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v16",
  });
  assert.equal(rowsWithWeakRelative[0].selectedParam, "balanced_reversal_stability_v51");
  assert.equal(rowsWithWeakRelative[0].selectionReason, "kept_incumbent_best");
});

test("walkForwardOptimize can rotate from fresh reversal to early broad beta attack through regime-v17", () => {
  const makeResult = (period, adaptiveReturn, excess, top) => {
    const [asOf, end] = period.split(":");
    const benchmarkReturn = adaptiveReturn - excess;
    return {
      asOf,
      end,
      top,
      adaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: benchmarkReturn,
      netWeightedBenchmarkReturn: benchmarkReturn,
      netAdaptiveExcessVsBenchmark: excess,
      benchmarkOverlayWeight: 0,
    };
  };
  const incumbentBasket = [{
    benchmarkR20: 0.04,
    benchmarkR60: 0.08,
    relativeR20: 0.12,
    relativeMomentumScore: 76,
    freshTrendScore: 62,
    industryResidualRankScore: 82,
    lotterySpikeScore: 88,
  }];
  const freshBasket = [{
    benchmarkR20: 0.07,
    benchmarkR60: 0.09,
    relativeR20: 0.18,
    relativeMomentumScore: 88,
    freshTrendScore: 74,
    industryResidualRankScore: 86,
    lotterySpikeScore: 95,
  }];
  const earlyBroadAttackBasket = [{
    benchmarkR20: 0.12,
    benchmarkR60: 0.16,
    relativeR20: 0.22,
    relativeMomentumScore: 93,
    freshTrendScore: 78,
    industryResidualRankScore: 76,
    lotterySpikeScore: 93,
  }];
  const crowdedAttackBasket = [{
    ...earlyBroadAttackBasket[0],
    industryResidualRankScore: 88,
  }];
  const weakFreshAttackBasket = [{
    ...earlyBroadAttackBasket[0],
    freshTrendScore: 66,
  }];
  const periods = [
    "2025-01-01:2025-03-01",
    "2025-02-01:2025-04-01",
    "2025-03-01:2025-05-01",
    "2025-04-01:2025-06-01",
  ];
  const periodResultsByParam = new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.03, 0.01, incumbentBasket),
      makeResult(periods[1], 0.02, 0.00, incumbentBasket),
      makeResult(periods[2], 0.02, 0.00, incumbentBasket),
      makeResult(periods[3], 0.03, 0.00, incumbentBasket),
    ]],
    ["rank_fresh_reversal_v54", [
      makeResult(periods[0], 0.08, 0.05, freshBasket),
      makeResult(periods[1], 0.07, 0.04, freshBasket),
      makeResult(periods[2], 0.06, 0.03, freshBasket),
      makeResult(periods[3], -0.01, -0.03, freshBasket),
    ]],
    ["rank_benchmark_state_attack_v32", [
      makeResult(periods[0], 0.02, 0.00, earlyBroadAttackBasket),
      makeResult(periods[1], 0.01, -0.01, earlyBroadAttackBasket),
      makeResult(periods[2], 0.00, -0.02, earlyBroadAttackBasket),
      makeResult(periods[3], 0.07, 0.04, earlyBroadAttackBasket),
    ]],
  ]);

  const rowsWithV16 = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v16",
  });
  const rowsWithV17 = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v17",
  });
  const rowsWithV19 = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v19",
  });

  assert.equal(rowsWithV16[0].selectedParam, "rank_fresh_reversal_v54");
  assert.equal(rowsWithV17[0].selectedParam, "rank_benchmark_state_attack_v32");
  assert.equal(rowsWithV19[0].selectedParam, "rank_benchmark_state_attack_v32");
  assert.equal(rowsWithV19[0].selectionReason, "switched_current_benchmark_early_broad_attack_overlay");
  assert.equal(rowsWithV17[0].selectionReason, "switched_current_benchmark_early_broad_attack_overlay");
  assert.equal(rowsWithV17[0].currentGateReason, "benchmark_early_broad_attack_overlay_applied");
  assert.equal(rowsWithV17[0].currentGateBenchmarkR20, 0.12);
  assert.equal(rowsWithV17[0].currentGateBenchmarkR60, 0.16);
  assert.equal(rowsWithV17[0].currentGateRelativeR20, 0.22);
  assert.equal(rowsWithV17[0].currentGateRelativeMomentum, 93);
  assert.equal(rowsWithV17[0].currentGateIndustryResidualRankScore, 76);

  periodResultsByParam.set("rank_benchmark_state_attack_v32", [
    makeResult(periods[0], 0.02, 0.00, crowdedAttackBasket),
    makeResult(periods[1], 0.01, -0.01, crowdedAttackBasket),
    makeResult(periods[2], 0.00, -0.02, crowdedAttackBasket),
    makeResult(periods[3], 0.07, 0.04, crowdedAttackBasket),
  ]);
  const rowsWithCrowding = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v17",
  });
  assert.equal(rowsWithCrowding[0].selectedParam, "rank_fresh_reversal_v54");

  periodResultsByParam.set("rank_benchmark_state_attack_v32", [
    makeResult(periods[0], 0.02, 0.00, weakFreshAttackBasket),
    makeResult(periods[1], 0.01, -0.01, weakFreshAttackBasket),
    makeResult(periods[2], 0.00, -0.02, weakFreshAttackBasket),
    makeResult(periods[3], 0.07, 0.04, weakFreshAttackBasket),
  ]);
  const rowsWithWeakFresh = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v17",
  });
  assert.equal(rowsWithWeakFresh[0].selectedParam, "rank_fresh_reversal_v54");
});

test("walkForwardOptimize can de-risk decaying mature fresh baskets through regime-v18", () => {
  const makeResult = (period, adaptiveReturn, excess, top, defensiveCashWeight = 0, exhaustionCashWeight = 0) => {
    const [asOf, end] = period.split(":");
    const benchmarkReturn = adaptiveReturn - excess;
    return {
      asOf,
      end,
      top,
      adaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: benchmarkReturn,
      netWeightedBenchmarkReturn: benchmarkReturn,
      netAdaptiveExcessVsBenchmark: excess,
      benchmarkOverlayWeight: 0,
      defensiveCashWeight,
      exhaustionCashWeight,
    };
  };
  const incumbentBasket = [{
    benchmarkR20: 0.03,
    benchmarkR60: 0.04,
    r20: 0.10,
    r60: 0.20,
    freshTrendScore: 50,
    shortTermReversalScore: 68,
    vol20: 0.36,
    relativeMomentumScore: 70,
    industryResidualMomentumScore: 95,
  }];
  const decayingFreshBasket = [{
    benchmarkR20: 0.08,
    benchmarkR60: 0.26,
    r20: 0.19,
    r60: 0.44,
    freshTrendScore: 63,
    shortTermReversalScore: 60,
    vol20: 0.50,
    relativeR20: 0.12,
    relativeMomentumScore: 88,
    industryResidualMomentumScore: 82,
    industryResidualRankScore: 76,
    lotterySpikeScore: 98,
  }];
  const healthyFreshBasket = [{
    ...decayingFreshBasket[0],
    freshTrendScore: 76,
    shortTermReversalScore: 70,
  }];
  const periods = [
    "2025-01-01:2025-03-01",
    "2025-02-01:2025-04-01",
    "2025-03-01:2025-05-01",
    "2025-04-01:2025-06-01",
  ];
  const periodResultsByParam = new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.03, 0.01, incumbentBasket),
      makeResult(periods[1], 0.02, 0.00, incumbentBasket),
      makeResult(periods[2], 0.02, 0.00, incumbentBasket),
      makeResult(periods[3], 0.01, -0.01, incumbentBasket),
    ]],
    ["rank_fresh_reversal_v54", [
      makeResult(periods[0], 0.01, 0.00, healthyFreshBasket),
      makeResult(periods[1], 0.01, 0.00, healthyFreshBasket),
      makeResult(periods[2], 0.01, 0.00, healthyFreshBasket),
      makeResult(periods[3], -0.06, -0.01, decayingFreshBasket),
    ]],
    ["rank_fresh_reversal_lottery_guard_v64", [
      makeResult(periods[0], 0.01, 0.00, healthyFreshBasket),
      makeResult(periods[1], 0.01, 0.00, healthyFreshBasket),
      makeResult(periods[2], 0.01, 0.00, healthyFreshBasket),
      makeResult(periods[3], -0.08, -0.03, decayingFreshBasket),
    ]],
    ["rank_fresh_reversal_crash_cash_v66", [
      makeResult(periods[0], 0.01, 0.00, healthyFreshBasket),
      makeResult(periods[1], 0.01, 0.00, healthyFreshBasket),
      makeResult(periods[2], 0.01, 0.00, healthyFreshBasket),
      makeResult(periods[3], -0.02, 0.03, decayingFreshBasket, 0.35, 0.35),
    ]],
  ]);

  const rowsWithV17 = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v17",
  });
  const rowsWithV18 = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v18",
  });

  assert.equal(rowsWithV17[0].selectedParam, "rank_fresh_reversal_v54");
  assert.equal(rowsWithV18[0].selectedParam, "rank_fresh_reversal_crash_cash_v66");
  assert.equal(rowsWithV18[0].selectionReason, "switched_current_fresh_decay_crash_overlay");
  assert.equal(rowsWithV18[0].currentGateReason, "fresh_decay_crash_overlay_applied");
  assert.equal(rowsWithV18[0].defensiveCashWeight, 0.35);

  const lowBenchmarkR20Basket = [{ ...decayingFreshBasket[0], benchmarkR20: 0.01 }];
  periodResultsByParam.set("rank_fresh_reversal_v54", [
    makeResult(periods[0], 0.01, 0.00, healthyFreshBasket),
    makeResult(periods[1], 0.01, 0.00, healthyFreshBasket),
    makeResult(periods[2], 0.01, 0.00, healthyFreshBasket),
    makeResult(periods[3], 0.18, 0.20, lowBenchmarkR20Basket),
  ]);
  periodResultsByParam.set("rank_fresh_reversal_crash_cash_v66", [
    makeResult(periods[0], 0.01, 0.00, healthyFreshBasket),
    makeResult(periods[1], 0.01, 0.00, healthyFreshBasket),
    makeResult(periods[2], 0.01, 0.00, healthyFreshBasket),
    makeResult(periods[3], 0.10, 0.12, decayingFreshBasket, 0.35, 0.35),
  ]);
  const rowsWithLowBenchmarkR20 = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v18",
  });
  assert.equal(rowsWithLowBenchmarkR20[0].selectedParam, "balanced_reversal_stability_v51");

  periodResultsByParam.set("rank_fresh_reversal_v54", [
    makeResult(periods[0], 0.20, 0.16, healthyFreshBasket),
    makeResult(periods[1], 0.18, 0.14, healthyFreshBasket),
    makeResult(periods[2], 0.16, 0.12, healthyFreshBasket),
    makeResult(periods[3], 0.18, 0.20, lowBenchmarkR20Basket),
  ]);
  const rowsWithLowBenchmarkSelectedFresh = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v18",
  });
  assert.equal(rowsWithLowBenchmarkSelectedFresh[0].selectedParam, "rank_fresh_reversal_v54");
});

test("walkForwardOptimize can apply mature beta rotation through regime-v5", () => {
  const makeResult = (period, adaptiveReturn, excess, top, benchmarkOverlayWeight = 0, exhaustionCashWeight = 0) => {
    const [asOf, end] = period.split(":");
    const benchmarkReturn = adaptiveReturn - excess;
    return {
      asOf,
      end,
      top,
      adaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: benchmarkReturn,
      netWeightedBenchmarkReturn: benchmarkReturn,
      netAdaptiveExcessVsBenchmark: excess,
      benchmarkOverlayWeight,
      exhaustionCashWeight,
    };
  };
  const normalBasket = [{
    freshTrendScore: 64,
    r20: 0.12,
    r60: 0.40,
    acceleration20vs60: 0.02,
    benchmarkR20: 0.04,
    benchmarkR60: 0.05,
    relativeR20: 0.08,
    relativeR60: 0.12,
    relativeMomentumScore: 82,
    industryResidualMomentumScore: 80,
  }];
  const matureBasket = [{
    freshTrendScore: 44,
    r20: 0.16,
    r60: 0.70,
    acceleration20vs60: -0.07,
    benchmarkR20: 0.00,
    benchmarkR60: 0.06,
    relativeR20: 0.16,
    relativeR60: 0.62,
    relativeMomentumScore: 95,
    industryResidualMomentumScore: 88,
  }];
  const periods = [
    "2026-01-01:2026-03-01",
    "2026-02-01:2026-04-01",
    "2026-03-01:2026-05-01",
    "2026-04-01:2026-06-01",
  ];
  const periodResultsByParam = new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.06, 0.03, normalBasket),
      makeResult(periods[1], 0.07, 0.03, normalBasket),
      makeResult(periods[2], 0.05, 0.01, normalBasket),
      makeResult(periods[3], -0.02, -0.06, matureBasket),
    ]],
    ["balanced_reversal_stability_mature_beta_rotation_v61", [
      makeResult(periods[0], 0.058, 0.028, normalBasket, 0, 0),
      makeResult(periods[1], 0.068, 0.028, normalBasket, 0, 0),
      makeResult(periods[2], 0.048, 0.008, normalBasket, 0, 0),
      makeResult(periods[3], -0.008, -0.048, matureBasket, 0.18, 0),
    ]],
    ["balanced_reversal_stability_mature_beta_rotation_stronger_v63", [
      makeResult(periods[0], 0.058, 0.028, normalBasket, 0, 0),
      makeResult(periods[1], 0.068, 0.028, normalBasket, 0, 0),
      makeResult(periods[2], 0.048, 0.008, normalBasket, 0, 0),
      makeResult(periods[3], 0.000, -0.040, matureBasket, 0.28, 0),
    ]],
    ["balanced_reversal_stability_mature_exhaustion_cash_v57", [
      makeResult(periods[0], 0.16, 0.13, normalBasket, 0, 0),
      makeResult(periods[1], 0.15, 0.11, normalBasket, 0, 0),
      makeResult(periods[2], 0.14, 0.10, normalBasket, 0, 0),
      makeResult(periods[3], -0.20, -0.24, matureBasket, 0, 0),
    ]],
  ]);

  const rows = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v5",
  });
  const rowsWithPullbackGate = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v6",
  });
  const rowsWithStrongerMatureGate = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v7",
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].selectedParam, "balanced_reversal_stability_mature_beta_rotation_v61");
  assert.equal(rows[0].selectionReason, "switched_current_exhaustion_overlay");
  assert.equal(rows[0].currentGateReason, "exhaustion_overlay_applied");
  assert.equal(rows[0].benchmarkOverlayWeight, 0.18);
  assert.equal(rowsWithPullbackGate[0].selectedParam, "balanced_reversal_stability_mature_beta_rotation_v61");
  assert.equal(rowsWithPullbackGate[0].currentGateReason, "exhaustion_overlay_applied");
  assert.equal(rowsWithStrongerMatureGate[0].selectedParam, "balanced_reversal_stability_mature_beta_rotation_stronger_v63");
  assert.equal(rowsWithStrongerMatureGate[0].currentGateReason, "exhaustion_overlay_applied");
  assert.equal(rowsWithStrongerMatureGate[0].benchmarkOverlayWeight, 0.28);
});

test("walkForwardOptimize can apply benchmark pullback catch-up through regime-v6", () => {
  const makeResult = (period, adaptiveReturn, excess, top, benchmarkOverlayWeight = 0) => {
    const [asOf, end] = period.split(":");
    const benchmarkReturn = adaptiveReturn - excess;
    return {
      asOf,
      end,
      top,
      adaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: benchmarkReturn,
      netWeightedBenchmarkReturn: benchmarkReturn,
      netAdaptiveExcessVsBenchmark: excess,
      benchmarkOverlayWeight,
    };
  };
  const normalBasket = [{
    freshTrendScore: 74,
    r20: 0.22,
    r60: 0.36,
    benchmarkR5: 0.01,
    benchmarkR20: 0.03,
    benchmarkR60: 0.04,
    relativeR20: 0.18,
    relativeMomentumScore: 88,
    vol20: 0.52,
    industryResidualMomentumScore: 82,
  }];
  const catchupBasket = [{
    freshTrendScore: 66,
    r20: 0.26,
    r60: 0.49,
    benchmarkR5: -0.024,
    benchmarkR20: 0.044,
    benchmarkR60: 0.069,
    relativeR20: 0.215,
    relativeMomentumScore: 94,
    vol20: 0.54,
    industryResidualMomentumScore: 83,
  }];
  const periods = [
    "2026-01-01:2026-03-01",
    "2026-02-01:2026-04-01",
    "2026-03-01:2026-05-01",
    "2026-04-01:2026-06-01",
  ];
  const periodResultsByParam = new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.06, 0.03, normalBasket),
      makeResult(periods[1], 0.07, 0.03, normalBasket),
      makeResult(periods[2], 0.05, 0.01, normalBasket),
      makeResult(periods[3], 0.10, -0.17, catchupBasket),
    ]],
    ["balanced_reversal_stability_benchmark_pullback_catchup_v62", [
      makeResult(periods[0], 0.058, 0.028, normalBasket, 0),
      makeResult(periods[1], 0.068, 0.028, normalBasket, 0),
      makeResult(periods[2], 0.048, 0.008, normalBasket, 0),
      makeResult(periods[3], 0.125, -0.145, catchupBasket, 0.15),
    ]],
    ["rank_fresh_reversal_v54", [
      makeResult(periods[0], 0.055, 0.025, normalBasket, 0),
      makeResult(periods[1], 0.062, 0.022, normalBasket, 0),
      makeResult(periods[2], 0.040, 0.000, normalBasket, 0),
      makeResult(periods[3], -0.20, -0.47, catchupBasket, 0),
    ]],
  ]);

  const rows = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v6",
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].selectedParam, "balanced_reversal_stability_benchmark_pullback_catchup_v62");
  assert.equal(rows[0].selectionReason, "switched_current_pullback_catchup_overlay");
  assert.equal(rows[0].currentGateReason, "pullback_catchup_overlay_applied");
  assert.equal(rows[0].benchmarkOverlayWeight, 0.15);
});

test("walkForwardOptimize can upgrade pullback catch-up to a stronger beta sleeve through regime-v19", () => {
  const makeResult = (period, adaptiveReturn, excess, top, benchmarkOverlayWeight = 0) => {
    const [asOf, end] = period.split(":");
    const benchmarkReturn = adaptiveReturn - excess;
    return {
      asOf,
      end,
      top,
      adaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: benchmarkReturn,
      netWeightedBenchmarkReturn: benchmarkReturn,
      netAdaptiveExcessVsBenchmark: excess,
      benchmarkOverlayWeight,
    };
  };
  const normalBasket = [{
    freshTrendScore: 72,
    r20: 0.18,
    r60: 0.32,
    benchmarkR5: 0.01,
    benchmarkR20: 0.03,
    benchmarkR60: 0.04,
    relativeR20: 0.18,
    relativeMomentumScore: 86,
    vol20: 0.48,
  }];
  const pullbackBetaBasket = [{
    freshTrendScore: 66,
    r20: 0.26,
    r60: 0.49,
    benchmarkR5: -0.024,
    benchmarkR20: 0.044,
    benchmarkR60: 0.069,
    relativeR20: 0.215,
    relativeMomentumScore: 94,
    vol20: 0.54,
  }];
  const periods = [
    "2026-01-01:2026-03-01",
    "2026-02-01:2026-04-01",
    "2026-03-01:2026-05-01",
    "2026-04-01:2026-06-01",
  ];
  const periodResultsByParam = new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.06, 0.03, normalBasket),
      makeResult(periods[1], 0.07, 0.03, normalBasket),
      makeResult(periods[2], 0.05, 0.01, normalBasket),
      makeResult(periods[3], 0.10, -0.17, pullbackBetaBasket),
    ]],
    ["balanced_reversal_stability_benchmark_pullback_catchup_v62", [
      makeResult(periods[0], 0.058, 0.028, normalBasket, 0),
      makeResult(periods[1], 0.068, 0.028, normalBasket, 0),
      makeResult(periods[2], 0.048, 0.008, normalBasket, 0),
      makeResult(periods[3], 0.125, -0.145, pullbackBetaBasket, 0.15),
    ]],
    ["balanced_reversal_stability_beta_recovery_stronger_v59", [
      makeResult(periods[0], 0.057, 0.027, normalBasket, 0),
      makeResult(periods[1], 0.067, 0.027, normalBasket, 0),
      makeResult(periods[2], 0.047, 0.007, normalBasket, 0),
      makeResult(periods[3], 0.20, -0.07, pullbackBetaBasket, 0.56),
    ]],
  ]);

  const rowsWithV18 = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v18",
  });
  const rowsWithV19 = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v19",
  });

  assert.equal(rowsWithV18[0].selectedParam, "balanced_reversal_stability_benchmark_pullback_catchup_v62");
  assert.equal(rowsWithV19[0].selectedParam, "balanced_reversal_stability_beta_recovery_stronger_v59");
  assert.equal(rowsWithV19[0].selectionReason, "switched_current_pullback_beta_boost_overlay");
  assert.equal(rowsWithV19[0].currentGateReason, "pullback_beta_boost_overlay_applied");
  assert.equal(rowsWithV19[0].benchmarkOverlayWeight, 0.56);

  periodResultsByParam.set("balanced_reversal_stability_beta_recovery_stronger_v59", [
    makeResult(periods[0], 0.057, 0.027, normalBasket, 0),
    makeResult(periods[1], 0.067, 0.027, normalBasket, 0),
    makeResult(periods[2], 0.047, 0.007, normalBasket, 0),
    makeResult(periods[3], 0.14, -0.13, pullbackBetaBasket, 0.30),
  ]);
  const rowsWithWeakBetaBoost = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v19",
  });
  assert.equal(rowsWithWeakBetaBoost[0].selectedParam, "balanced_reversal_stability_benchmark_pullback_catchup_v62");
});

test("walkForwardOptimize can escalate strong beta recovery exposure through regime-v20", () => {
  const makeResult = (period, adaptiveReturn, excess, top, benchmarkOverlayWeight = 0) => {
    const [asOf, end] = period.split(":");
    const benchmarkReturn = adaptiveReturn - excess;
    return {
      asOf,
      end,
      top,
      adaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: benchmarkReturn,
      netWeightedBenchmarkReturn: benchmarkReturn,
      netAdaptiveExcessVsBenchmark: excess,
      benchmarkOverlayWeight,
    };
  };
  const normalBasket = [{
    freshTrendScore: 72,
    r20: 0.18,
    r60: 0.32,
    benchmarkR5: 0.01,
    benchmarkR20: 0.03,
    benchmarkR60: 0.04,
    relativeR20: 0.18,
    relativeMomentumScore: 86,
    vol20: 0.48,
  }];
  const betaBasket = [{
    freshTrendScore: 68,
    r20: 0.24,
    r60: 0.48,
    benchmarkR5: -0.018,
    benchmarkR20: 0.044,
    benchmarkR60: 0.070,
    relativeR20: 0.215,
    relativeMomentumScore: 94,
    vol20: 0.54,
  }];
  const periods = [
    "2026-01-01:2026-03-01",
    "2026-02-01:2026-04-01",
    "2026-03-01:2026-05-01",
    "2026-04-01:2026-06-01",
  ];
  const periodResultsByParam = new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.06, 0.03, normalBasket),
      makeResult(periods[1], 0.07, 0.03, normalBasket),
      makeResult(periods[2], 0.05, 0.01, normalBasket),
      makeResult(periods[3], 0.10, -0.17, betaBasket),
    ]],
    ["balanced_reversal_stability_benchmark_pullback_catchup_v62", [
      makeResult(periods[0], 0.058, 0.028, normalBasket, 0),
      makeResult(periods[1], 0.068, 0.028, normalBasket, 0),
      makeResult(periods[2], 0.048, 0.008, normalBasket, 0),
      makeResult(periods[3], 0.125, -0.145, betaBasket, 0.15),
    ]],
    ["balanced_reversal_stability_beta_recovery_stronger_v59", [
      makeResult(periods[0], 0.057, 0.027, normalBasket, 0),
      makeResult(periods[1], 0.067, 0.027, normalBasket, 0),
      makeResult(periods[2], 0.047, 0.007, normalBasket, 0),
      makeResult(periods[3], 0.20, -0.07, betaBasket, 0.56),
    ]],
    ["balanced_reversal_stability_beta_recovery_high_conviction_v67", [
      makeResult(periods[0], 0.056, 0.026, normalBasket, 0),
      makeResult(periods[1], 0.066, 0.026, normalBasket, 0),
      makeResult(periods[2], 0.046, 0.006, normalBasket, 0),
      makeResult(periods[3], 0.23, -0.04, betaBasket, 0.76),
    ]],
  ]);

  const rowsWithV19 = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v19",
  });
  const rowsWithV20 = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v20",
  });

  assert.equal(rowsWithV19[0].selectedParam, "balanced_reversal_stability_beta_recovery_stronger_v59");
  assert.equal(rowsWithV20[0].selectedParam, "balanced_reversal_stability_beta_recovery_high_conviction_v67");
  assert.equal(rowsWithV20[0].selectionReason, "switched_current_beta_recovery_high_conviction_overlay");
  assert.equal(rowsWithV20[0].currentGateReason, "beta_recovery_high_conviction_overlay_applied");
  assert.equal(rowsWithV20[0].benchmarkOverlayWeight, 0.76);

  periodResultsByParam.set("balanced_reversal_stability_beta_recovery_high_conviction_v67", [
    makeResult(periods[0], 0.056, 0.026, normalBasket, 0),
    makeResult(periods[1], 0.066, 0.026, normalBasket, 0),
    makeResult(periods[2], 0.046, 0.006, normalBasket, 0),
    makeResult(periods[3], 0.205, -0.065, betaBasket, 0.60),
  ]);
  const rowsWithWeakHighConviction = walkForwardOptimize(periodResultsByParam, {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v20",
  });
  assert.equal(rowsWithWeakHighConviction[0].selectedParam, "balanced_reversal_stability_beta_recovery_stronger_v59");
});

test("walkForwardOptimize can directly guard moderate fresh baskets against lottery spikes through regime-v21", () => {
  const makeResult = (period, adaptiveReturn, excess, top, scoredCount = 1500) => {
    const [asOf, end] = period.split(":");
    const benchmarkReturnValue = adaptiveReturn - excess;
    return {
      asOf,
      end,
      top,
      scoredCount,
      adaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: benchmarkReturnValue,
      netWeightedBenchmarkReturn: benchmarkReturnValue,
      netAdaptiveExcessVsBenchmark: excess,
    };
  };
  const periods = [
    "2026-01-01:2026-03-01",
    "2026-02-01:2026-04-01",
    "2026-03-01:2026-05-01",
    "2026-04-01:2026-06-01",
  ];
  const stableBasket = [{
    freshTrendScore: 55,
    r20: 0.10,
    r60: 0.22,
    relativeR20: 0.12,
    relativeMomentumScore: 78,
    industryResidualMomentumScore: 70,
    industryResidualRankScore: 70,
    lotterySpikeScore: 94,
    maxDailyReturn20: 0.065,
    vol20: 0.45,
  }];
  const freshBasket = [{
    freshTrendScore: 64,
    r20: 0.18,
    r60: 0.31,
    relativeR20: 0.19,
    relativeMomentumScore: 88,
    industryResidualMomentumScore: 82,
    industryResidualRankScore: 82,
    lotterySpikeScore: 90,
    maxDailyReturn20: 0.10,
    vol20: 0.65,
  }];
  const guardedBasket = [{
    freshTrendScore: 60,
    r20: 0.13,
    r60: 0.22,
    relativeR20: 0.15,
    relativeMomentumScore: 84,
    industryResidualMomentumScore: 78,
    industryResidualRankScore: 78,
    lotterySpikeScore: 97.5,
    maxDailyReturn20: 0.07,
    vol20: 0.58,
  }];
  const makePeriodResults = (guardedCurrent = makeResult(periods[3], 0.09, 0.03, guardedBasket)) => new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.03, 0.02, stableBasket),
      makeResult(periods[1], 0.035, 0.02, stableBasket),
      makeResult(periods[2], 0.025, 0.01, stableBasket),
      makeResult(periods[3], 0.04, 0.01, stableBasket),
    ]],
    ["rank_fresh_reversal_v54", [
      makeResult(periods[0], 0.08, 0.05, freshBasket),
      makeResult(periods[1], 0.09, 0.06, freshBasket),
      makeResult(periods[2], 0.07, 0.04, freshBasket),
      makeResult(periods[3], 0.05, 0.01, freshBasket),
    ]],
    ["rank_fresh_reversal_lottery_guard_v64", [
      makeResult(periods[0], 0.02, 0.01, guardedBasket),
      makeResult(periods[1], 0.03, 0.015, guardedBasket),
      makeResult(periods[2], 0.02, 0.01, guardedBasket),
      guardedCurrent,
    ]],
  ]);

  const rowsWithV20 = walkForwardOptimize(makePeriodResults(), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v20",
  });
  const rowsWithV21 = walkForwardOptimize(makePeriodResults(), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v21",
  });

  assert.equal(rowsWithV20[0].selectedParam, "rank_fresh_reversal_v54");
  assert.equal(rowsWithV21[0].selectedParam, "rank_fresh_reversal_lottery_guard_v64");
  assert.equal(rowsWithV21[0].selectionReason, "switched_current_direct_fresh_lottery_guard_overlay");
  assert.equal(rowsWithV21[0].currentGateReason, "direct_fresh_lottery_guard_overlay_applied");
  assert.equal(rowsWithV21[0].currentGateLotteryGuardScore, 97.5);
  assert.equal(rowsWithV21[0].currentGateLotteryGuardFreshTrend, 60);

  const rowsWithNarrowPool = walkForwardOptimize(makePeriodResults(makeResult(periods[3], 0.09, 0.03, guardedBasket, 1100)), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v21",
  });
  assert.equal(rowsWithNarrowPool[0].selectedParam, "rank_fresh_reversal_v54");

  const weaklyGuardedBasket = [{ ...guardedBasket[0], maxDailyReturn20: 0.085 }];
  const rowsWithWeakGuard = walkForwardOptimize(makePeriodResults(makeResult(periods[3], 0.09, 0.03, weaklyGuardedBasket)), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v21",
  });
  assert.equal(rowsWithWeakGuard[0].selectedParam, "rank_fresh_reversal_v54");
});

test("walkForwardOptimize can rotate overextended fresh winners into stable reversal baskets through regime-v22", () => {
  const makeResult = (period, adaptiveReturn, excess, top, scoredCount = 1500) => {
    const [asOf, end] = period.split(":");
    const benchmarkReturnValue = adaptiveReturn - excess;
    return {
      asOf,
      end,
      top,
      scoredCount,
      adaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: benchmarkReturnValue,
      netWeightedBenchmarkReturn: benchmarkReturnValue,
      netAdaptiveExcessVsBenchmark: excess,
    };
  };
  const periods = [
    "2026-01-01:2026-03-01",
    "2026-02-01:2026-04-01",
    "2026-03-01:2026-05-01",
    "2026-04-01:2026-06-01",
  ];
  const stableBasket = [{
    freshTrendScore: 58,
    r20: 0.10,
    relativeMomentumScore: 82,
    industryResidualMomentumScore: 74,
    industryResidualRankScore: 78,
    shortTermReversalScore: 68,
    turnoverStabilityScore: 70,
    lotterySpikeScore: 92,
    maxDailyReturn20: 0.07,
    vol20: 0.45,
  }];
  const overextendedFreshBasket = [{
    freshTrendScore: 83,
    r20: 0.30,
    relativeMomentumScore: 90,
    industryResidualMomentumScore: 77,
    industryResidualRankScore: 76,
    shortTermReversalScore: 69,
    turnoverStabilityScore: 68,
    lotterySpikeScore: 94,
    maxDailyReturn20: 0.092,
    vol20: 0.62,
  }];
  const stableReversalBasket = [{
    freshTrendScore: 55,
    r20: 0.24,
    relativeMomentumScore: 92,
    industryResidualMomentumScore: 83,
    industryResidualRankScore: 83,
    shortTermReversalScore: 73,
    turnoverStabilityScore: 75,
    lotterySpikeScore: 96,
    maxDailyReturn20: 0.078,
    vol20: 0.59,
  }];
  const makePeriodResults = ({
    freshCurrent = overextendedFreshBasket,
    reversalCurrent = stableReversalBasket,
  } = {}) => new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.035, 0.015, stableBasket),
      makeResult(periods[1], 0.040, 0.020, stableBasket),
      makeResult(periods[2], 0.030, 0.010, stableBasket),
      makeResult(periods[3], 0.050, 0.010, stableBasket),
    ]],
    ["rank_fresh_reversal_v54", [
      makeResult(periods[0], 0.085, 0.050, overextendedFreshBasket),
      makeResult(periods[1], 0.095, 0.055, overextendedFreshBasket),
      makeResult(periods[2], 0.075, 0.040, overextendedFreshBasket),
      makeResult(periods[3], 0.030, -0.010, freshCurrent),
    ]],
    ["rank_reversal_stability_v52", [
      makeResult(periods[0], 0.020, 0.010, stableReversalBasket),
      makeResult(periods[1], 0.025, 0.012, stableReversalBasket),
      makeResult(periods[2], 0.020, 0.010, stableReversalBasket),
      makeResult(periods[3], 0.100, 0.060, reversalCurrent),
    ]],
  ]);

  const rowsWithV21 = walkForwardOptimize(makePeriodResults(), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v21",
  });
  const rowsWithV22 = walkForwardOptimize(makePeriodResults(), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v22",
  });

  assert.equal(rowsWithV21[0].selectedParam, "rank_fresh_reversal_v54");
  assert.equal(rowsWithV22[0].selectedParam, "rank_reversal_stability_v52");
  assert.equal(rowsWithV22[0].selectionReason, "switched_current_fresh_reversal_stability_overlay");
  assert.equal(rowsWithV22[0].currentGateReason, "fresh_reversal_stability_overlay_applied");
  assert.equal(rowsWithV22[0].currentGateFreshTrend, 55);
  assert.equal(rowsWithV22[0].currentGateShortTermReversalScore, 73);
  assert.equal(rowsWithV22[0].currentGateTurnoverStabilityScore, 75);

  const rowsWithStrongFreshIndustryRank = walkForwardOptimize(makePeriodResults({
    freshCurrent: [{ ...overextendedFreshBasket[0], industryResidualRankScore: 86 }],
  }), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v22",
  });
  assert.equal(rowsWithStrongFreshIndustryRank[0].selectedParam, "rank_fresh_reversal_v54");

  const rowsWithWeakReversalCandidate = walkForwardOptimize(makePeriodResults({
    reversalCurrent: [{ ...stableReversalBasket[0], lotterySpikeScore: 90, maxDailyReturn20: 0.105 }],
  }), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v22",
  });
  assert.equal(rowsWithWeakReversalCandidate[0].selectedParam, "rank_fresh_reversal_v54");
});

test("walkForwardOptimize can rescue weak fresh margin switches with volume-confirmed momentum through regime-v23", () => {
  const makeResult = (period, adaptiveReturn, excess, top, scoredCount = 1500) => {
    const [asOf, end] = period.split(":");
    const benchmarkReturnValue = adaptiveReturn - excess;
    return {
      asOf,
      end,
      top,
      scoredCount,
      adaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: benchmarkReturnValue,
      netWeightedBenchmarkReturn: benchmarkReturnValue,
      netAdaptiveExcessVsBenchmark: excess,
    };
  };
  const periods = [
    "2026-01-01:2026-03-01",
    "2026-02-01:2026-04-01",
    "2026-03-01:2026-05-01",
    "2026-04-01:2026-06-01",
  ];
  const stableBasket = [{
    freshTrendScore: 30,
    r20: 0.09,
    relativeR20: 0.10,
    volumeMomentumScore: 42,
    volumeTurnoverRatio5v20: 1.0,
    relativeMomentumScore: 78,
    industryResidualMomentumScore: 70,
    lotterySpikeScore: 88,
  }];
  const weakFreshBasket = [{
    freshTrendScore: 45,
    r20: 0.14,
    relativeR20: 0.15,
    volumeMomentumScore: 44,
    volumeTurnoverRatio5v20: 1.05,
    relativeMomentumScore: 84,
    industryResidualMomentumScore: 72,
    lotterySpikeScore: 89,
    maxDailyReturn20: 0.095,
    vol20: 0.68,
  }];
  const volumeMomentumBasket = [{
    freshTrendScore: 74,
    r20: 0.21,
    relativeR20: 0.23,
    volumeMomentumScore: 74,
    volumeTurnoverRatio5v20: 1.75,
    relativeMomentumScore: 94,
    industryResidualMomentumScore: 88,
    industryResidualRankScore: 88,
    lotterySpikeScore: 84,
    maxDailyReturn20: 0.115,
    vol20: 0.77,
    entryDayReturn: 0.038,
  }];
  const makePeriodResults = ({
    freshCurrent = weakFreshBasket,
    volumeCurrent = volumeMomentumBasket,
  } = {}) => new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.035, 0.015, stableBasket),
      makeResult(periods[1], 0.040, 0.020, stableBasket),
      makeResult(periods[2], 0.030, 0.010, stableBasket),
      makeResult(periods[3], 0.040, 0.010, stableBasket),
    ]],
    ["rank_fresh_reversal_v54", [
      makeResult(periods[0], 0.085, 0.050, weakFreshBasket),
      makeResult(periods[1], 0.095, 0.055, weakFreshBasket),
      makeResult(periods[2], 0.075, 0.040, weakFreshBasket),
      makeResult(periods[3], -0.010, -0.030, freshCurrent),
    ]],
    ["rank_volume_momentum_balanced_v28", [
      makeResult(periods[0], 0.020, 0.010, volumeMomentumBasket),
      makeResult(periods[1], 0.025, 0.012, volumeMomentumBasket),
      makeResult(periods[2], 0.020, 0.010, volumeMomentumBasket),
      makeResult(periods[3], 0.055, 0.025, volumeCurrent),
    ]],
  ]);

  const rowsWithV22 = walkForwardOptimize(makePeriodResults(), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v22",
  });
  const rowsWithV23 = walkForwardOptimize(makePeriodResults(), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v23",
  });

  assert.equal(rowsWithV22[0].selectedParam, "rank_fresh_reversal_v54");
  assert.equal(rowsWithV23[0].selectedParam, "rank_volume_momentum_balanced_v28");
  assert.equal(rowsWithV23[0].selectionReason, "switched_current_fresh_volume_momentum_overlay");
  assert.equal(rowsWithV23[0].currentGateReason, "fresh_volume_momentum_overlay_applied");
  assert.equal(rowsWithV23[0].currentGateFreshTrend, 74);
  assert.equal(rowsWithV23[0].currentGateVolumeMomentumScore, 74);
  assert.equal(rowsWithV23[0].currentGateVolumeTurnoverRatio, 1.75);

  const rowsWithStrongFreshIncumbent = walkForwardOptimize(makePeriodResults({
    freshCurrent: [{ ...weakFreshBasket[0], freshTrendScore: 72, r20: 0.28, relativeMomentumScore: 92 }],
  }), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v23",
  });
  assert.equal(rowsWithStrongFreshIncumbent[0].selectedParam, "rank_fresh_reversal_v54");

  const rowsWithFrenzyVolumeCandidate = walkForwardOptimize(makePeriodResults({
    volumeCurrent: [{ ...volumeMomentumBasket[0], freshTrendScore: 86, r20: 0.36, lotterySpikeScore: 94 }],
  }), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v23",
  });
  assert.equal(rowsWithFrenzyVolumeCandidate[0].selectedParam, "rank_fresh_reversal_v54");
});

test("walkForwardOptimize can rotate stable incumbents into reversal-stability baskets through regime-v24", () => {
  const makeResult = (period, adaptiveReturn, excess, top) => {
    const [asOf, end] = period.split(":");
    const benchmarkReturnValue = adaptiveReturn - excess;
    return {
      asOf,
      end,
      top,
      scoredCount: 1200,
      adaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: benchmarkReturnValue,
      netWeightedBenchmarkReturn: benchmarkReturnValue,
      netAdaptiveExcessVsBenchmark: excess,
    };
  };
  const periods = [
    "2026-01-01:2026-03-01",
    "2026-02-01:2026-04-01",
    "2026-03-01:2026-05-01",
    "2026-04-01:2026-06-01",
  ];
  const stableBasket = [{
    freshTrendScore: 64,
    r20: 0.30,
    relativeR20: 0.30,
    relativeMomentumScore: 95,
    shortTermReversalScore: 62,
    turnoverStabilityScore: 67,
    lotterySpikeScore: 91,
    maxDailyReturn20: 0.10,
    vol20: 0.68,
  }];
  const reversalStabilityBasket = [{
    freshTrendScore: 69,
    r20: 0.23,
    relativeR20: 0.22,
    relativeMomentumScore: 90,
    industryResidualRankScore: 88,
    shortTermReversalScore: 68,
    turnoverStabilityScore: 74,
    lotterySpikeScore: 90.5,
    maxDailyReturn20: 0.085,
    vol20: 0.60,
    volumeMomentumScore: 63,
    volumeTurnoverRatio5v20: 1.2,
  }];
  const makePeriodResults = ({ reversalCurrent = reversalStabilityBasket } = {}) => new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.060, 0.035, stableBasket),
      makeResult(periods[1], 0.055, 0.030, stableBasket),
      makeResult(periods[2], 0.050, 0.025, stableBasket),
      makeResult(periods[3], -0.020, 0.020, stableBasket),
    ]],
    ["rank_reversal_stability_v52", [
      makeResult(periods[0], 0.020, 0.010, reversalStabilityBasket),
      makeResult(periods[1], 0.015, 0.005, reversalStabilityBasket),
      makeResult(periods[2], 0.018, 0.006, reversalStabilityBasket),
      makeResult(periods[3], 0.030, 0.070, reversalCurrent),
    ]],
  ]);

  const rowsWithV23 = walkForwardOptimize(makePeriodResults(), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v23",
  });
  const rowsWithV24 = walkForwardOptimize(makePeriodResults(), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v24",
  });

  assert.equal(rowsWithV23[0].selectedParam, "balanced_reversal_stability_v51");
  assert.equal(rowsWithV24[0].selectedParam, "rank_reversal_stability_v52");
  assert.equal(rowsWithV24[0].selectionReason, "switched_current_incumbent_reversal_stability_overlay");
  assert.equal(rowsWithV24[0].currentGateReason, "incumbent_reversal_stability_overlay_applied");
  assert.equal(rowsWithV24[0].currentGateFreshTrend, 69);
  assert.equal(rowsWithV24[0].currentGateRelativeR20, 0.22);
  assert.equal(rowsWithV24[0].currentGateTurnoverStabilityScore, 74);

  const rowsWithWeakReversalCandidate = walkForwardOptimize(makePeriodResults({
    reversalCurrent: [{ ...reversalStabilityBasket[0], freshTrendScore: 62, relativeR20: 0.14, industryResidualRankScore: 80 }],
  }), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v24",
  });
  assert.equal(rowsWithWeakReversalCandidate[0].selectedParam, "balanced_reversal_stability_v51");
});

test("walkForwardOptimize can rotate benchmark pullback attack into volume momentum through regime-v25", () => {
  const makeResult = (period, adaptiveReturn, excess, top) => {
    const [asOf, end] = period.split(":");
    const benchmarkReturnValue = adaptiveReturn - excess;
    return {
      asOf,
      end,
      top,
      scoredCount: 1500,
      adaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: benchmarkReturnValue,
      netWeightedBenchmarkReturn: benchmarkReturnValue,
      netAdaptiveExcessVsBenchmark: excess,
    };
  };
  const periods = [
    "2026-01-01:2026-03-01",
    "2026-02-01:2026-04-01",
    "2026-03-01:2026-05-01",
    "2026-04-01:2026-06-01",
  ];
  const stableBasket = [{
    freshTrendScore: 48,
    r20: 0.10,
    relativeR20: 0.12,
    relativeMomentumScore: 86,
    industryResidualRankScore: 84,
    industryResidualMomentumScore: 82,
    benchmarkR20: -0.045,
    benchmarkR60: 0.09,
  }];
  const attackBasket = [{
    freshTrendScore: 42,
    r20: 0.12,
    relativeR20: 0.18,
    relativeMomentumScore: 92,
    industryResidualRankScore: 86,
    industryResidualMomentumScore: 90,
    benchmarkR20: -0.045,
    benchmarkR60: 0.09,
  }];
  const volumeMomentumBasket = [{
    freshTrendScore: 68,
    r20: 0.26,
    relativeR20: 0.28,
    relativeMomentumScore: 100,
    industryResidualRankScore: 94,
    volumeMomentumScore: 78,
    volumeTurnoverRatio5v20: 1.55,
    lotterySpikeScore: 85,
    maxDailyReturn20: 0.11,
    vol20: 0.68,
    entryDayReturn: 0.02,
    benchmarkR20: -0.025,
    benchmarkR60: 0.08,
  }];
  const makePeriodResults = ({ volumeCurrent = volumeMomentumBasket } = {}) => new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.030, 0.010, stableBasket),
      makeResult(periods[1], 0.025, 0.008, stableBasket),
      makeResult(periods[2], 0.028, 0.009, stableBasket),
      makeResult(periods[3], 0.015, 0.020, stableBasket),
    ]],
    ["rank_benchmark_state_attack_v32", [
      makeResult(periods[0], 0.060, 0.040, attackBasket),
      makeResult(periods[1], 0.065, 0.045, attackBasket),
      makeResult(periods[2], 0.055, 0.035, attackBasket),
      makeResult(periods[3], 0.045, 0.020, attackBasket),
    ]],
    ["rank_volume_momentum_balanced_v28", [
      makeResult(periods[0], 0.010, 0.000, volumeMomentumBasket),
      makeResult(periods[1], 0.012, 0.002, volumeMomentumBasket),
      makeResult(periods[2], 0.011, 0.001, volumeMomentumBasket),
      makeResult(periods[3], 0.080, 0.035, volumeCurrent),
    ]],
  ]);

  const rowsWithV24 = walkForwardOptimize(makePeriodResults(), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v24",
  });
  const rowsWithV25 = walkForwardOptimize(makePeriodResults(), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v25",
  });

  assert.equal(rowsWithV24[0].selectedParam, "rank_benchmark_state_attack_v32");
  assert.equal(rowsWithV25[0].selectedParam, "rank_volume_momentum_balanced_v28");
  assert.equal(rowsWithV25[0].selectionReason, "switched_current_benchmark_pullback_volume_momentum_overlay");
  assert.equal(rowsWithV25[0].currentGateReason, "benchmark_pullback_volume_momentum_overlay_applied");
  assert.equal(rowsWithV25[0].currentGateFreshTrend, 68);
  assert.equal(rowsWithV25[0].currentGateRelativeR20, 0.28);

  const rowsWithOverheatedCandidate = walkForwardOptimize(makePeriodResults({
    volumeCurrent: [{ ...volumeMomentumBasket[0], freshTrendScore: 78, relativeR20: 0.36, lotterySpikeScore: 91 }],
  }), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v25",
  });
  assert.equal(rowsWithOverheatedCandidate[0].selectedParam, "rank_benchmark_state_attack_v32");
});

test("walkForwardOptimize can upgrade residual-confirmed pullback attack into volume momentum through regime-v28", () => {
  const makeResult = (period, adaptiveReturn, excess, top) => {
    const [asOf, end] = period.split(":");
    const benchmarkReturnValue = adaptiveReturn - excess;
    return {
      asOf,
      end,
      top,
      scoredCount: 1500,
      adaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: benchmarkReturnValue,
      netWeightedBenchmarkReturn: benchmarkReturnValue,
      netAdaptiveExcessVsBenchmark: excess,
    };
  };
  const periods = [
    "2025-09-01:2025-11-01",
    "2025-10-01:2025-12-01",
    "2025-11-01:2026-01-01",
    "2025-12-01:2026-02-01",
  ];
  const stableBasket = [{
    freshTrendScore: 54,
    r20: 0.18,
    relativeR20: 0.20,
    relativeMomentumScore: 87,
    industryResidualRankScore: 82,
    industryResidualMomentumScore: 82,
    benchmarkR20: -0.02,
    benchmarkR60: 0.05,
  }];
  const attackBasket = [{
    freshTrendScore: 58,
    r20: 0.19,
    relativeR20: 0.22,
    relativeMomentumScore: 90,
    industryResidualRankScore: 93,
    industryResidualMomentumScore: 93,
    benchmarkR20: -0.032,
    benchmarkR60: 0.06,
  }];
  const residualVolumeBasket = [{
    freshTrendScore: 77,
    r20: 0.24,
    relativeR20: 0.27,
    relativeMomentumScore: 92,
    industryResidualRankScore: 95,
    volumeMomentumScore: 77,
    volumeTurnoverRatio5v20: 1.92,
    lotterySpikeScore: 78,
    entryDayReturn: 0.015,
    maxDailyReturn20: 0.13,
    vol20: 0.76,
    benchmarkR20: -0.032,
    benchmarkR60: 0.06,
  }];
  const makePeriodResults = ({ volumeCurrent = residualVolumeBasket } = {}) => new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.070, 0.040, stableBasket),
      makeResult(periods[1], 0.065, 0.035, stableBasket),
      makeResult(periods[2], 0.060, 0.030, stableBasket),
      makeResult(periods[3], 0.015, 0.020, stableBasket),
    ]],
    ["rank_benchmark_state_attack_v32", [
      makeResult(periods[0], 0.030, 0.010, attackBasket),
      makeResult(periods[1], 0.032, 0.012, attackBasket),
      makeResult(periods[2], 0.031, 0.011, attackBasket),
      makeResult(periods[3], 0.080, 0.050, attackBasket),
    ]],
    ["rank_volume_momentum_balanced_v28", [
      makeResult(periods[0], 0.010, 0.000, residualVolumeBasket),
      makeResult(periods[1], 0.012, 0.002, residualVolumeBasket),
      makeResult(periods[2], 0.011, 0.001, residualVolumeBasket),
      makeResult(periods[3], 0.240, 0.200, volumeCurrent),
    ]],
  ]);

  const rowsWithV27 = walkForwardOptimize(makePeriodResults(), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v27",
  });
  const rowsWithV28 = walkForwardOptimize(makePeriodResults(), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v28",
  });

  assert.equal(rowsWithV27[0].selectedParam, "rank_benchmark_state_attack_v32");
  assert.equal(rowsWithV28[0].selectedParam, "rank_volume_momentum_balanced_v28");
  assert.equal(rowsWithV28[0].selectionReason, "switched_current_benchmark_pullback_residual_volume_momentum_overlay");
  assert.equal(rowsWithV28[0].currentGateReason, "benchmark_pullback_residual_volume_momentum_overlay_applied");
  assert.equal(rowsWithV28[0].currentGateFreshTrend, 77);
  assert.equal(rowsWithV28[0].currentGateIndustryResidualRankScore, 95);
  assert.equal(rowsWithV28[0].currentGateVolumeMomentumScore, 77);
  assert.equal(rowsWithV28[0].currentGateEntryDayReturn, 0.015);

  const rowsWithHotEntry = walkForwardOptimize(makePeriodResults({
    volumeCurrent: [{ ...residualVolumeBasket[0], entryDayReturn: 0.035 }],
  }), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v28",
  });
  assert.equal(rowsWithHotEntry[0].selectedParam, "rank_benchmark_state_attack_v32");
});

test("walkForwardOptimize can rotate broad-pool early recovery into reversal stability through regime-v29", () => {
  const makeResult = (period, adaptiveReturn, excess, top, scoredCount = 1550) => {
    const [asOf, end] = period.split(":");
    const benchmarkReturnValue = adaptiveReturn - excess;
    return {
      asOf,
      end,
      top,
      scoredCount,
      adaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: benchmarkReturnValue,
      netWeightedBenchmarkReturn: benchmarkReturnValue,
      netAdaptiveExcessVsBenchmark: excess,
    };
  };
  const periods = [
    "2025-10-01:2025-12-01",
    "2025-11-01:2026-01-01",
    "2025-12-01:2026-02-01",
    "2026-01-01:2026-03-01",
  ];
  const stableBasket = [{
    freshTrendScore: 76,
    r20: 0.21,
    relativeR20: 0.19,
    relativeMomentumScore: 92,
    shortTermReversalScore: 59,
    turnoverStabilityScore: 55,
    volumeMomentumScore: 73,
    lotterySpikeScore: 94,
    maxDailyReturn20: 0.09,
    vol20: 0.51,
    benchmarkR20: 0.02,
    benchmarkR60: 0,
    industryBreadth20: 0.65,
  }];
  const broadReversalBasket = [{
    freshTrendScore: 62,
    r20: 0.196,
    relativeR20: 0.156,
    relativeMomentumScore: 90.5,
    industryResidualRankScore: 86,
    shortTermReversalScore: 70,
    turnoverStabilityScore: 74.5,
    volumeMomentumScore: 68,
    volumeTurnoverRatio5v20: 1.17,
    lotterySpikeScore: 93.9,
    entryDayReturn: 0.01,
    maxDailyReturn20: 0.08,
    vol20: 0.54,
    benchmarkR20: 0.039,
    benchmarkR60: -0.026,
    industryBreadth20: 0.78,
  }];
  const makePeriodResults = ({ reversalCurrent = broadReversalBasket, reversalScoredCount = 1550 } = {}) => new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.070, 0.040, stableBasket),
      makeResult(periods[1], 0.065, 0.035, stableBasket),
      makeResult(periods[2], 0.060, 0.030, stableBasket),
      makeResult(periods[3], 0.063, 0.054, stableBasket),
    ]],
    ["rank_reversal_stability_v52", [
      makeResult(periods[0], 0.015, 0.005, broadReversalBasket),
      makeResult(periods[1], 0.018, 0.006, broadReversalBasket),
      makeResult(periods[2], 0.020, 0.008, broadReversalBasket),
      makeResult(periods[3], 0.122, 0.113, reversalCurrent, reversalScoredCount),
    ]],
  ]);

  const rowsWithV28 = walkForwardOptimize(makePeriodResults(), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v28",
  });
  const rowsWithV29 = walkForwardOptimize(makePeriodResults(), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v29",
  });

  assert.equal(rowsWithV28[0].selectedParam, "balanced_reversal_stability_v51");
  assert.equal(rowsWithV29[0].selectedParam, "rank_reversal_stability_v52");
  assert.equal(rowsWithV29[0].selectionReason, "switched_current_broad_pool_reversal_stability_overlay");
  assert.equal(rowsWithV29[0].currentGateReason, "broad_pool_reversal_stability_overlay_applied");
  assert.equal(rowsWithV29[0].currentGateFreshTrend, 62);
  assert.equal(rowsWithV29[0].currentGateIndustryBreadth20, 0.78);

  const rowsWithNarrowPool = walkForwardOptimize(makePeriodResults({ reversalScoredCount: 1160 }), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v29",
  });
  assert.equal(rowsWithNarrowPool[0].selectedParam, "balanced_reversal_stability_v51");
});

test("walkForwardOptimize can rotate broad-pool deep pullback attack into reversal stability through regime-v30", () => {
  const makeResult = (period, adaptiveReturn, excess, top, scoredCount = 1560) => {
    const [asOf, end] = period.split(":");
    const benchmarkReturnValue = adaptiveReturn - excess;
    return {
      asOf,
      end,
      top,
      scoredCount,
      adaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: benchmarkReturnValue,
      netWeightedBenchmarkReturn: benchmarkReturnValue,
      netAdaptiveExcessVsBenchmark: excess,
    };
  };
  const periods = [
    "2025-01-01:2025-03-01",
    "2025-02-01:2025-04-01",
    "2025-03-01:2025-05-01",
    "2025-04-01:2025-06-01",
  ];
  const stableBasket = [{
    freshTrendScore: 52,
    r20: 0.11,
    relativeR20: 0.14,
    relativeMomentumScore: 82,
    industryResidualRankScore: 76,
    benchmarkR20: -0.04,
    benchmarkR60: 0.06,
  }];
  const attackBasket = [{
    freshTrendScore: 47,
    r20: 0.15,
    relativeR20: 0.205,
    relativeMomentumScore: 92,
    industryResidualRankScore: 75,
    benchmarkR20: -0.057,
    benchmarkR60: 0.117,
  }];
  const pullbackReversalBasket = [{
    freshTrendScore: 44,
    r20: 0.123,
    relativeR20: 0.164,
    relativeMomentumScore: 91,
    industryResidualRankScore: 81,
    shortTermReversalScore: 64.5,
    turnoverStabilityScore: 67,
    volumeMomentumScore: 50,
    volumeTurnoverRatio5v20: 1.14,
    lotterySpikeScore: 96.5,
    entryDayReturn: 0.009,
    maxDailyReturn20: 0.073,
    vol20: 0.435,
    benchmarkR20: -0.041,
    benchmarkR60: 0.062,
    industryBreadth20: 0.55,
  }];
  const lowBreadthReversalBasket = [{
    ...pullbackReversalBasket[0],
    industryBreadth20: 0.42,
    relativeMomentumScore: 74,
  }];
  const makePeriodResults = ({ reversalCurrent = pullbackReversalBasket, reversalScoredCount = 1560 } = {}) => new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.070, 0.040, stableBasket),
      makeResult(periods[1], 0.065, 0.035, stableBasket),
      makeResult(periods[2], 0.060, 0.030, stableBasket),
      makeResult(periods[3], 0.016, 0.053, stableBasket),
    ]],
    ["rank_benchmark_state_attack_v32", [
      makeResult(periods[0], 0.030, 0.010, attackBasket),
      makeResult(periods[1], 0.032, 0.012, attackBasket),
      makeResult(periods[2], 0.031, 0.011, attackBasket),
      makeResult(periods[3], 0.027, 0.070, attackBasket),
    ]],
    ["rank_reversal_stability_v52", [
      makeResult(periods[0], 0.015, 0.005, pullbackReversalBasket),
      makeResult(periods[1], 0.018, 0.006, pullbackReversalBasket),
      makeResult(periods[2], 0.020, 0.008, pullbackReversalBasket),
      makeResult(periods[3], 0.064, 0.097, reversalCurrent, reversalScoredCount),
    ]],
  ]);

  const rowsWithV29 = walkForwardOptimize(makePeriodResults(), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v29",
  });
  const rowsWithV30 = walkForwardOptimize(makePeriodResults(), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v30",
  });

  assert.equal(rowsWithV29[0].selectedParam, "rank_benchmark_state_attack_v32");
  assert.equal(rowsWithV30[0].selectedParam, "rank_reversal_stability_v52");
  assert.equal(rowsWithV30[0].selectionReason, "switched_current_benchmark_pullback_reversal_stability_overlay");
  assert.equal(rowsWithV30[0].currentGateReason, "benchmark_pullback_reversal_stability_overlay_applied");
  assert.equal(rowsWithV30[0].currentGateBenchmarkR20, -0.041);
  assert.equal(rowsWithV30[0].currentGateIndustryBreadth20, 0.55);

  const rowsWithWeakBreadth = walkForwardOptimize(makePeriodResults({ reversalCurrent: lowBreadthReversalBasket }), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v30",
  });
  assert.equal(rowsWithWeakBreadth[0].selectedParam, "rank_benchmark_state_attack_v32");

  const rowsWithNarrowPool = walkForwardOptimize(makePeriodResults({ reversalScoredCount: 1170 }), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v30",
  });
  assert.equal(rowsWithNarrowPool[0].selectedParam, "rank_benchmark_state_attack_v32");
});

test("walkForwardOptimize can rotate broad-pool early volume momentum through regime-v31", () => {
  const makeResult = (period, adaptiveReturn, excess, top, scoredCount = 1560) => {
    const [asOf, end] = period.split(":");
    const benchmarkReturnValue = adaptiveReturn - excess;
    return {
      asOf,
      end,
      top,
      scoredCount,
      adaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: benchmarkReturnValue,
      netWeightedBenchmarkReturn: benchmarkReturnValue,
      netAdaptiveExcessVsBenchmark: excess,
    };
  };
  const periods = [
    "2025-04-01:2025-06-01",
    "2025-05-01:2025-07-01",
    "2025-06-01:2025-08-01",
    "2025-07-01:2025-09-01",
  ];
  const stableBasket = [{
    freshTrendScore: 81,
    r20: 0.28,
    relativeR20: 0.21,
    relativeMomentumScore: 91,
    industryResidualRankScore: 86,
    volumeMomentumScore: 71,
    lotterySpikeScore: 79,
    benchmarkR20: 0.04,
    benchmarkR60: 0.02,
    industryBreadth20: 0.83,
  }];
  const earlyVolumeMomentumBasket = [{
    freshTrendScore: 86.5,
    r20: 0.357,
    relativeR20: 0.32,
    relativeMomentumScore: 96.9,
    industryResidualRankScore: 84,
    shortTermReversalScore: 58,
    turnoverStabilityScore: 62,
    volumeMomentumScore: 84.6,
    volumeTurnoverRatio5v20: 1.52,
    lotterySpikeScore: 90,
    entryDayReturn: 0.013,
    maxDailyReturn20: 0.101,
    vol20: 0.53,
    benchmarkR20: 0.037,
    benchmarkR60: 0.005,
    industryBreadth20: 0.93,
  }];
  const overheatedBenchmarkBasket = [{
    ...earlyVolumeMomentumBasket[0],
    benchmarkR20: 0.05,
    benchmarkR60: 0.063,
  }];
  const makePeriodResults = ({ volumeCurrent = earlyVolumeMomentumBasket, volumeScoredCount = 1560 } = {}) => new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.070, 0.040, stableBasket),
      makeResult(periods[1], 0.065, 0.035, stableBasket),
      makeResult(periods[2], 0.060, 0.030, stableBasket),
      makeResult(periods[3], 0.530, 0.327, stableBasket),
    ]],
    ["rank_volume_momentum_balanced_v28", [
      makeResult(periods[0], 0.012, 0.004, earlyVolumeMomentumBasket),
      makeResult(periods[1], 0.018, 0.006, earlyVolumeMomentumBasket),
      makeResult(periods[2], 0.022, 0.008, earlyVolumeMomentumBasket),
      makeResult(periods[3], 0.658, 0.408, volumeCurrent, volumeScoredCount),
    ]],
  ]);

  const rowsWithV30 = walkForwardOptimize(makePeriodResults(), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v30",
  });
  const rowsWithV31 = walkForwardOptimize(makePeriodResults(), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v31",
  });

  assert.equal(rowsWithV30[0].selectedParam, "balanced_reversal_stability_v51");
  assert.equal(rowsWithV31[0].selectedParam, "rank_volume_momentum_balanced_v28");
  assert.equal(rowsWithV31[0].selectionReason, "switched_current_broad_pool_volume_momentum_overlay");
  assert.equal(rowsWithV31[0].currentGateReason, "broad_pool_volume_momentum_overlay_applied");
  assert.equal(rowsWithV31[0].currentGateBenchmarkR20, 0.037);
  assert.equal(rowsWithV31[0].currentGateIndustryBreadth20, 0.93);

  const rowsWithNarrowPool = walkForwardOptimize(makePeriodResults({ volumeScoredCount: 1270 }), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v31",
  });
  assert.equal(rowsWithNarrowPool[0].selectedParam, "balanced_reversal_stability_v51");

  const rowsWithOverheatedBenchmark = walkForwardOptimize(makePeriodResults({ volumeCurrent: overheatedBenchmarkBasket }), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v31",
  });
  assert.equal(rowsWithOverheatedBenchmark[0].selectedParam, "balanced_reversal_stability_v51");
});

test("walkForwardOptimize can rotate narrow-pool no-static meltups through regime-v32", () => {
  const makeResult = (period, adaptiveReturn, excess, top, scoredCount = 1180) => {
    const [asOf, end] = period.split(":");
    const benchmarkReturnValue = adaptiveReturn - excess;
    return {
      asOf,
      end,
      top,
      scoredCount,
      adaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: benchmarkReturnValue,
      netWeightedBenchmarkReturn: benchmarkReturnValue,
      netAdaptiveExcessVsBenchmark: excess,
    };
  };
  const periods = [
    "2025-05-01:2025-07-01",
    "2025-06-01:2025-08-01",
    "2025-07-01:2025-09-01",
    "2025-08-01:2025-10-01",
  ];
  const stableBasket = [{
    freshTrendScore: 69,
    r20: 0.24,
    relativeR20: 0.18,
    relativeMomentumScore: 86,
    volumeMomentumScore: 63,
    volumeTurnoverRatio5v20: 1.22,
    lotterySpikeScore: 95,
    entryDayReturn: 0.012,
    maxDailyReturn20: 0.09,
    vol20: 0.50,
    benchmarkR20: 0.04,
    benchmarkR60: 0.05,
  }];
  const noStaticMeltupBasket = [{
    freshTrendScore: 68,
    r20: 0.25,
    r60: 0.42,
    relativeR20: 0.21,
    relativeMomentumScore: 90,
    volumeMomentumScore: 74,
    volumeTurnoverRatio5v20: 1.54,
    lotterySpikeScore: 92.3,
    entryDayReturn: -0.006,
    maxDailyReturn20: 0.089,
    vol20: 0.505,
    benchmarkR20: 0.037,
    benchmarkR60: 0.062,
  }];
  const overheatedNoStaticBasket = [{
    ...noStaticMeltupBasket[0],
    benchmarkR60: 0.12,
  }];
  const lotteryNoStaticBasket = [{
    ...noStaticMeltupBasket[0],
    lotterySpikeScore: 96,
  }];
  const makePeriodResults = ({ noStaticCurrent = noStaticMeltupBasket, noStaticScoredCount = 1180 } = {}) => new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.050, 0.020, stableBasket),
      makeResult(periods[1], 0.055, 0.022, stableBasket),
      makeResult(periods[2], 0.060, 0.025, stableBasket),
      makeResult(periods[3], 0.418, 0.118, stableBasket),
    ]],
    ["balanced_reversal_stability_mature_beta_rotation_stronger_v63_no_static_theme", [
      makeResult(periods[0], -0.020, -0.030, noStaticMeltupBasket),
      makeResult(periods[1], -0.010, -0.020, noStaticMeltupBasket),
      makeResult(periods[2], -0.015, -0.025, noStaticMeltupBasket),
      makeResult(periods[3], 0.461, 0.195, noStaticCurrent, noStaticScoredCount),
    ]],
  ]);

  const rowsWithV31 = walkForwardOptimize(makePeriodResults(), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v31",
  });
  const rowsWithV32 = walkForwardOptimize(makePeriodResults(), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v32",
  });

  assert.equal(rowsWithV31[0].selectedParam, "balanced_reversal_stability_v51");
  assert.equal(rowsWithV32[0].selectedParam, "balanced_reversal_stability_mature_beta_rotation_stronger_v63_no_static_theme");
  assert.equal(rowsWithV32[0].selectionReason, "switched_current_narrow_no_static_meltup_overlay");
  assert.equal(rowsWithV32[0].currentGateReason, "narrow_no_static_meltup_overlay_applied");
  assert.equal(rowsWithV32[0].currentGateBenchmarkR20, 0.037);
  assert.equal(rowsWithV32[0].currentGateVolumeMomentumScore, 74);

  const rowsWithWidePool = walkForwardOptimize(makePeriodResults({ noStaticScoredCount: 1550 }), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v32",
  });
  assert.equal(rowsWithWidePool[0].selectedParam, "balanced_reversal_stability_v51");

  const rowsWithOverheatedNoStatic = walkForwardOptimize(makePeriodResults({ noStaticCurrent: overheatedNoStaticBasket }), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v32",
  });
  assert.equal(rowsWithOverheatedNoStatic[0].selectedParam, "balanced_reversal_stability_v51");

  const rowsWithLotteryNoStatic = walkForwardOptimize(makePeriodResults({ noStaticCurrent: lotteryNoStaticBasket }), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v32",
  });
  assert.equal(rowsWithLotteryNoStatic[0].selectedParam, "balanced_reversal_stability_v51");
});

test("walkForwardOptimize can rotate tired fresh-rotation lottery guards into reversal stability through regime-v26", () => {
  const makeResult = (period, adaptiveReturn, excess, top) => {
    const [asOf, end] = period.split(":");
    const benchmarkReturnValue = adaptiveReturn - excess;
    return {
      asOf,
      end,
      top,
      scoredCount: 1500,
      adaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedBenchmarkReturn: benchmarkReturnValue,
      netWeightedBenchmarkReturn: benchmarkReturnValue,
      netAdaptiveExcessVsBenchmark: excess,
    };
  };
  const periods = [
    "2025-07-01:2025-09-01",
    "2025-08-01:2025-10-01",
    "2025-09-01:2025-11-01",
    "2025-10-01:2025-12-01",
  ];
  const stableBasket = [{
    freshTrendScore: 55,
    r20: 0.10,
    relativeMomentumScore: 80,
    industryResidualMomentumScore: 90,
    industryResidualRankScore: 82,
  }];
  const freshRotationBasket = [{
    freshTrendScore: 78,
    r20: 0.28,
    relativeMomentumScore: 88,
    industryResidualMomentumScore: 70,
    industryResidualRankScore: 75,
    benchmarkR20: 0.11,
    benchmarkR60: 0.38,
  }];
  const tiredLotteryGuardBasket = [{
    freshTrendScore: 77,
    r20: 0.27,
    relativeR20: 0.18,
    relativeMomentumScore: 80,
    industryResidualRankScore: 77,
    industryResidualMomentumScore: 76,
    shortTermReversalScore: 68,
    turnoverStabilityScore: 66,
    lotterySpikeScore: 98.2,
    maxDailyReturn20: 0.074,
    vol20: 0.48,
    entryDayReturn: -0.001,
    volumeMomentumScore: 76,
    volumeTurnoverRatio5v20: 1.29,
  }];
  const reversalStabilityBasket = [{
    freshTrendScore: 59,
    r20: 0.28,
    relativeR20: 0.17,
    relativeMomentumScore: 85,
    industryResidualRankScore: 81,
    industryResidualMomentumScore: 82,
    shortTermReversalScore: 70,
    turnoverStabilityScore: 73,
    lotterySpikeScore: 86,
    maxDailyReturn20: 0.115,
    vol20: 0.64,
    entryDayReturn: 0.004,
  }];
  const makePeriodResults = ({ lotteryCurrent = tiredLotteryGuardBasket } = {}) => new Map([
    ["balanced_reversal_stability_v51", [
      makeResult(periods[0], 0.030, 0.010, stableBasket),
      makeResult(periods[1], 0.035, 0.012, stableBasket),
      makeResult(periods[2], 0.032, 0.011, stableBasket),
      makeResult(periods[3], 0.010, 0.015, stableBasket),
    ]],
    ["rank_fresh_reversal_v54", [
      makeResult(periods[0], 0.010, 0.000, freshRotationBasket),
      makeResult(periods[1], 0.012, 0.002, freshRotationBasket),
      makeResult(periods[2], 0.011, 0.001, freshRotationBasket),
      makeResult(periods[3], 0.020, -0.010, freshRotationBasket),
    ]],
    ["rank_fresh_reversal_lottery_guard_v64", [
      makeResult(periods[0], 0.008, 0.000, tiredLotteryGuardBasket),
      makeResult(periods[1], 0.009, 0.001, tiredLotteryGuardBasket),
      makeResult(periods[2], 0.010, 0.001, tiredLotteryGuardBasket),
      makeResult(periods[3], -0.025, -0.010, lotteryCurrent),
    ]],
    ["rank_reversal_stability_v52", [
      makeResult(periods[0], 0.000, -0.005, reversalStabilityBasket),
      makeResult(periods[1], 0.002, -0.004, reversalStabilityBasket),
      makeResult(periods[2], 0.001, -0.003, reversalStabilityBasket),
      makeResult(periods[3], 0.015, 0.025, reversalStabilityBasket),
    ]],
  ]);

  const rowsWithV25 = walkForwardOptimize(makePeriodResults(), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v25",
  });
  const rowsWithV26 = walkForwardOptimize(makePeriodResults(), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v26",
  });

  assert.equal(rowsWithV25[0].selectedParam, "rank_fresh_reversal_lottery_guard_v64");
  assert.equal(rowsWithV26[0].selectedParam, "rank_reversal_stability_v52");
  assert.equal(rowsWithV26[0].selectionReason, "switched_current_fresh_rotation_reversal_stability_overlay");
  assert.equal(rowsWithV26[0].currentGateReason, "fresh_rotation_reversal_stability_overlay_applied");
  assert.equal(rowsWithV26[0].currentGateFreshTrend, 59);
  assert.equal(rowsWithV26[0].currentGateTurnoverStabilityScore, 73);
  assert.equal(rowsWithV26[0].currentGateLotteryGuardScore, 86);

  const rowsWithNotFreshEnoughLotteryGuard = walkForwardOptimize(makePeriodResults({
    lotteryCurrent: [{ ...tiredLotteryGuardBasket[0], freshTrendScore: 71 }],
  }), {
    minTrainPeriods: 3,
    stableParamName: "balanced_reversal_stability_v51",
    switchMargin: 0.01,
    incumbentPolicy: "stable",
    currentBasketGate: "regime-v26",
  });
  assert.equal(rowsWithNotFreshEnoughLotteryGuard[0].selectedParam, "rank_fresh_reversal_lottery_guard_v64");
});

test("walkForwardEnsembleOptimize blends top training strategies using only prior periods", () => {
  const makeResult = (period, adaptiveReturn, excess, code) => {
    const [asOf, end] = period.split(":");
    const benchmarkReturnValue = adaptiveReturn - excess;
    const top = [{
      code,
      name: code,
      recommendedWeight: 1,
      recommendedWeightPct: 100,
      forwardReturn: adaptiveReturn,
      netForwardReturn: adaptiveReturn,
      benchmarkForwardReturn: benchmarkReturnValue,
      netBenchmarkForwardReturn: benchmarkReturnValue,
    }];
    return {
      asOf,
      end,
      top,
      adaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedTopReturn: adaptiveReturn,
      netWeightedTopReturn: adaptiveReturn,
      topMeanReturn: adaptiveReturn,
      netTopMeanReturn: adaptiveReturn,
      weightedBenchmarkReturn: benchmarkReturnValue,
      netWeightedBenchmarkReturn: benchmarkReturnValue,
      benchmarkOverlayWeight: 0,
      adaptiveExcessVsBenchmark: excess,
      netAdaptiveExcessVsBenchmark: excess,
      weightedExcessVsBenchmark: excess,
      netWeightedExcessVsBenchmark: excess,
      adaptiveWeightedExcessReturn: excess,
      netAdaptiveWeightedExcessReturn: excess,
      universeMeanReturn: 0,
      netUniverseMeanReturn: 0,
      scoredCount: 10,
      skippedCount: 0,
    };
  };
  const periods = [
    "2026-01-01:2026-03-01",
    "2026-02-01:2026-04-01",
    "2026-03-01:2026-05-01",
    "2026-04-01:2026-06-01",
  ];
  const periodResultsByParam = new Map([
    ["spiky_winner", [
      makeResult(periods[0], 0.18, 0.05, "A"),
      makeResult(periods[1], 0.20, 0.04, "A"),
      makeResult(periods[2], 0.22, 0.06, "A"),
      makeResult(periods[3], -0.20, -0.24, "A"),
    ]],
    ["steady_runner_up", [
      makeResult(periods[0], 0.15, 0.04, "B"),
      makeResult(periods[1], 0.16, 0.04, "B"),
      makeResult(periods[2], 0.17, 0.05, "B"),
      makeResult(periods[3], 0.10, 0.08, "B"),
    ]],
  ]);

  const single = walkForwardOptimize(periodResultsByParam, { minTrainPeriods: 3 });
  const ensemble = walkForwardEnsembleOptimize(periodResultsByParam, { minTrainPeriods: 3, topK: 2 });

  assert.equal(single[0].selectedParam, "spiky_winner");
  assert.equal(ensemble.length, 1);
  assert.deepEqual(ensemble[0].selectedParams, ["spiky_winner", "steady_runner_up"]);
  assert.equal(Number(ensemble[0].netAdaptiveWeightedTopReturn.toFixed(6)), -0.05);
  assert.equal(Number(ensemble[0].netAdaptiveExcessVsBenchmark.toFixed(6)), -0.08);
  assert.ok(ensemble[0].netAdaptiveWeightedTopReturn > single[0].netAdaptiveWeightedTopReturn);
  assert.deepEqual(ensemble[0].top.map((row) => [row.code, row.recommendedWeight]), [["A", 0.5], ["B", 0.5]]);
});

test("walkForwardPoolSelect chooses stock pool using only prior periods", () => {
  const makePoolRow = (period, adaptiveReturn, excess, poolName) => {
    const [asOf, end] = period.split(":");
    const benchmarkReturnValue = adaptiveReturn - excess;
    return {
      period,
      asOf,
      end,
      selectedParam: `${poolName}_sleeve`,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveExcessVsBenchmark: excess,
      netAdaptiveWeightedExcessReturn: excess + 0.01,
      netWeightedTopReturn: adaptiveReturn,
      weightedTopReturn: adaptiveReturn,
      netWeightedBenchmarkReturn: benchmarkReturnValue,
      benchmarkOverlayWeight: 0,
      scoredCount: 100,
      skippedCount: 0,
      top: [{ code: poolName, recommendedWeight: 1, netForwardReturn: adaptiveReturn }],
    };
  };
  const periods = [
    "2026-01-01:2026-03-01",
    "2026-02-01:2026-04-01",
    "2026-03-01:2026-05-01",
    "2026-04-01:2026-06-01",
    "2026-05-01:2026-07-01",
  ];
  const rowsByPool = new Map([
    ["merged", [
      makePoolRow(periods[0], 0.10, 0.04, "merged"),
      makePoolRow(periods[1], 0.11, 0.04, "merged"),
      makePoolRow(periods[2], 0.10, 0.03, "merged"),
      makePoolRow(periods[3], 0.08, 0.02, "merged"),
      makePoolRow(periods[4], 0.02, -0.01, "merged"),
    ]],
    ["physical", [
      makePoolRow(periods[0], 0.04, 0.02, "physical"),
      makePoolRow(periods[1], 0.05, 0.02, "physical"),
      makePoolRow(periods[2], 0.12, 0.05, "physical"),
      makePoolRow(periods[3], 0.16, 0.08, "physical"),
      makePoolRow(periods[4], 0.18, 0.09, "physical"),
    ]],
  ]);

  const selected = walkForwardPoolSelect(rowsByPool, {
    minTrainPeriods: 2,
    lookbackPeriods: 2,
    initialPool: "merged",
    scoreExcessWeight: 0.35,
  });

  assert.equal(selected.length, 3);
  assert.equal(selected[0].period, periods[2]);
  assert.equal(selected[0].selectedPool, "merged");
  assert.equal(selected[0].netAdaptiveWeightedTopReturn, 0.10);
  assert.equal(selected[0].poolSelectionReason, "selected_by_prior_pool_score");
  assert.equal(selected[2].period, periods[4]);
  assert.equal(selected[2].selectedPool, "physical");
  assert.equal(selected[2].netAdaptiveWeightedTopReturn, 0.18);
  assert.equal(selected[2].trainingLookbackPeriods, 2);

  const withWarmup = walkForwardPoolSelect(rowsByPool, {
    minTrainPeriods: 2,
    lookbackPeriods: 2,
    initialPool: "merged",
    scoreExcessWeight: 0.35,
    includeWarmup: true,
  });

  assert.equal(withWarmup.length, 5);
  assert.equal(withWarmup[0].selectedPool, "merged");
  assert.equal(withWarmup[0].poolSelectionReason, "warmup_initial_pool");
  assert.equal(withWarmup[1].selectedPool, "merged");
  assert.equal(withWarmup[2].selectedPool, "merged");
  assert.equal(withWarmup[4].selectedPool, "physical");

  const stringRowsByPool = new Map(Array.from(rowsByPool.entries()).map(([name, rows]) => [
    name,
    rows.map((row) => ({
      ...row,
      netAdaptiveWeightedTopReturn: String(row.netAdaptiveWeightedTopReturn),
      netAdaptiveExcessVsBenchmark: String(row.netAdaptiveExcessVsBenchmark),
      netAdaptiveWeightedExcessReturn: String(row.netAdaptiveWeightedExcessReturn),
    })),
  ]));
  const selectedFromCsvLikeRows = walkForwardPoolSelect(stringRowsByPool, {
    minTrainPeriods: 2,
    lookbackPeriods: 2,
    initialPool: "merged",
    scoreExcessWeight: 0.35,
    includeWarmup: true,
  });
  assert.equal(selectedFromCsvLikeRows[4].selectedPool, "physical");
});

test("walkForwardPoolSelect can keep the incumbent pool when the challenger edge is small", () => {
  const makePoolRow = (period, adaptiveReturn, poolName) => {
    const [asOf, end] = period.split(":");
    return {
      period,
      asOf,
      end,
      selectedParam: `${poolName}_sleeve`,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveExcessVsBenchmark: 0,
      netAdaptiveWeightedExcessReturn: 0,
      netWeightedTopReturn: adaptiveReturn,
      weightedTopReturn: adaptiveReturn,
      netWeightedBenchmarkReturn: adaptiveReturn,
      benchmarkOverlayWeight: 0,
      scoredCount: 100,
      skippedCount: 0,
      top: [{ code: poolName, recommendedWeight: 1, netForwardReturn: adaptiveReturn }],
    };
  };
  const periods = [
    "2026-01-01:2026-03-01",
    "2026-02-01:2026-04-01",
    "2026-03-01:2026-05-01",
    "2026-04-01:2026-06-01",
    "2026-05-01:2026-07-01",
  ];
  const rowsByPool = new Map([
    ["merged", periods.map((period) => makePoolRow(period, 0.10, "merged"))],
    ["physical", [
      makePoolRow(periods[0], 0.07, "physical"),
      makePoolRow(periods[1], 0.07, "physical"),
      makePoolRow(periods[2], 0.12, "physical"),
      makePoolRow(periods[3], 0.13, "physical"),
      makePoolRow(periods[4], 0.14, "physical"),
    ]],
  ]);

  const sticky = walkForwardPoolSelect(rowsByPool, {
    minTrainPeriods: 2,
    lookbackPeriods: 2,
    initialPool: "merged",
    incumbentPolicy: "rolling",
    switchMargin: 0.04,
  });

  assert.equal(sticky[2].period, periods[4]);
  assert.equal(sticky[2].candidatePool, "physical");
  assert.equal(sticky[2].selectedPool, "merged");
  assert.equal(sticky[2].poolSelectionReason, "kept_incumbent_margin");
  assert.equal(Number(sticky[2].poolScoreAdvantage.toFixed(6)), 0.025);

  const loose = walkForwardPoolSelect(rowsByPool, {
    minTrainPeriods: 2,
    lookbackPeriods: 2,
    initialPool: "merged",
    incumbentPolicy: "rolling",
    switchMargin: 0.01,
  });
  assert.equal(loose[2].selectedPool, "physical");
  assert.equal(loose[2].poolSelectionReason, "selected_by_prior_pool_score");
});

test("walkForwardPoolSelect can require prior pool windows to be known by the current asOf", () => {
  const makePoolRow = (period, adaptiveReturn, poolName) => {
    const [asOf, end] = period.split(":");
    return {
      period,
      asOf,
      end,
      selectedParam: `${poolName}_sleeve`,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveExcessVsBenchmark: adaptiveReturn,
      netAdaptiveWeightedExcessReturn: adaptiveReturn,
      netWeightedTopReturn: adaptiveReturn,
      weightedTopReturn: adaptiveReturn,
      netWeightedBenchmarkReturn: 0,
      benchmarkOverlayWeight: 0,
      scoredCount: 100,
      skippedCount: 0,
      top: [{ code: poolName, recommendedWeight: 1, netForwardReturn: adaptiveReturn }],
    };
  };
  const periods = [
    "2026-01-01:2026-03-01",
    "2026-02-01:2026-04-01",
    "2026-03-01:2026-05-01",
    "2026-04-01:2026-06-01",
  ];
  const rowsByPool = new Map([
    ["overlap", [
      makePoolRow(periods[0], 0.01, "overlap"),
      makePoolRow(periods[1], 0.80, "overlap"),
      makePoolRow(periods[2], 0.80, "overlap"),
      makePoolRow(periods[3], 0.80, "overlap"),
    ]],
    ["known", periods.map((period) => makePoolRow(period, 0.10, "known"))],
  ]);

  const leaky = walkForwardPoolSelect(rowsByPool, {
    minTrainPeriods: 1,
    lookbackPeriods: 4,
    initialPool: "known",
    scoreExcessWeight: 0,
  });
  assert.equal(leaky[1].period, periods[2]);
  assert.equal(leaky[1].selectedPool, "overlap");

  const strict = walkForwardPoolSelect(rowsByPool, {
    minTrainPeriods: 1,
    lookbackPeriods: 4,
    initialPool: "known",
    scoreExcessWeight: 0,
    knownOutcomeOnly: true,
  });
  assert.equal(strict[0].period, periods[2]);
  assert.equal(strict[0].selectedPool, "known");
  assert.equal(strict[0].trainingPeriods, 1);
});

test("walkForwardPoolSelect keeps warmup while known-outcome training windows are insufficient", () => {
  const makePoolRow = (period, adaptiveReturn, poolName) => {
    const [asOf, end] = period.split(":");
    return {
      period,
      asOf,
      end,
      selectedParam: `${poolName}_sleeve`,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveExcessVsBenchmark: adaptiveReturn,
      netAdaptiveWeightedExcessReturn: adaptiveReturn,
      netWeightedTopReturn: adaptiveReturn,
      weightedTopReturn: adaptiveReturn,
      netWeightedBenchmarkReturn: 0,
      benchmarkOverlayWeight: 0,
      scoredCount: 100,
      skippedCount: 0,
      top: [{ code: poolName, recommendedWeight: 1, netForwardReturn: adaptiveReturn }],
    };
  };
  const periods = [
    "2026-01-01:2026-03-01",
    "2026-02-01:2026-04-01",
    "2026-03-01:2026-05-01",
    "2026-04-01:2026-06-01",
  ];
  const rowsByPool = new Map([
    ["initial", periods.map((period) => makePoolRow(period, 0.10, "initial"))],
    ["overlap", [
      makePoolRow(periods[0], 0.01, "overlap"),
      makePoolRow(periods[1], 0.80, "overlap"),
      makePoolRow(periods[2], 0.80, "overlap"),
      makePoolRow(periods[3], 0.80, "overlap"),
    ]],
  ]);

  const selected = walkForwardPoolSelect(rowsByPool, {
    minTrainPeriods: 2,
    lookbackPeriods: 4,
    initialPool: "initial",
    scoreExcessWeight: 0,
    knownOutcomeOnly: true,
    includeWarmup: true,
  });

  assert.equal(selected[2].period, periods[2]);
  assert.equal(selected[2].selectedPool, "initial");
  assert.equal(selected[2].poolSelectionReason, "warmup_initial_pool");
  assert.equal(selected[2].trainingPeriods, 0);
  assert.equal(selected[3].period, periods[3]);
  assert.equal(selected[3].selectedPool, "overlap");
  assert.equal(selected[3].poolSelectionReason, "selected_by_prior_pool_score");
  assert.equal(selected[3].trainingPeriods, 2);
});

test("walkForwardEnsembleOptimize preserves null returns when selected sleeve has no TopN", () => {
  const makeResult = (period, adaptiveReturn, excess, code) => {
    const [asOf, end] = period.split(":");
    if (adaptiveReturn == null) {
      return {
        asOf,
        end,
        top: [],
        adaptiveWeightedTopReturn: null,
        netAdaptiveWeightedTopReturn: null,
        weightedTopReturn: null,
        netWeightedTopReturn: null,
        topMeanReturn: null,
        netTopMeanReturn: null,
        weightedBenchmarkReturn: null,
        netWeightedBenchmarkReturn: null,
        benchmarkOverlayWeight: 0,
        adaptiveExcessVsBenchmark: null,
        netAdaptiveExcessVsBenchmark: null,
        weightedExcessVsBenchmark: null,
        netWeightedExcessVsBenchmark: null,
        adaptiveWeightedExcessReturn: null,
        netAdaptiveWeightedExcessReturn: null,
        universeMeanReturn: null,
        netUniverseMeanReturn: null,
        scoredCount: 0,
        skippedCount: 10,
      };
    }
    const benchmarkReturnValue = adaptiveReturn - excess;
    return {
      asOf,
      end,
      top: [{
        code,
        name: code,
        recommendedWeight: 1,
        recommendedWeightPct: 100,
        forwardReturn: adaptiveReturn,
        netForwardReturn: adaptiveReturn,
        benchmarkForwardReturn: benchmarkReturnValue,
        netBenchmarkForwardReturn: benchmarkReturnValue,
      }],
      adaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedTopReturn: adaptiveReturn,
      netWeightedTopReturn: adaptiveReturn,
      topMeanReturn: adaptiveReturn,
      netTopMeanReturn: adaptiveReturn,
      weightedBenchmarkReturn: benchmarkReturnValue,
      netWeightedBenchmarkReturn: benchmarkReturnValue,
      benchmarkOverlayWeight: 0,
      adaptiveExcessVsBenchmark: excess,
      netAdaptiveExcessVsBenchmark: excess,
      weightedExcessVsBenchmark: excess,
      netWeightedExcessVsBenchmark: excess,
      adaptiveWeightedExcessReturn: excess,
      netAdaptiveWeightedExcessReturn: excess,
      universeMeanReturn: 0,
      netUniverseMeanReturn: 0,
      scoredCount: 10,
      skippedCount: 0,
    };
  };
  const periodResultsByParam = new Map([
    ["candidate", [
      makeResult("2026-01-01:2026-03-01", 0.10, 0.04, "A"),
      makeResult("2026-02-01:2026-04-01", 0.11, 0.05, "A"),
      makeResult("2026-03-01:2026-05-01", null, null, "A"),
    ]],
  ]);

  const ensemble = walkForwardEnsembleOptimize(periodResultsByParam, { minTrainPeriods: 2, topK: 1 });

  assert.equal(ensemble.length, 1);
  assert.equal(ensemble[0].netAdaptiveWeightedTopReturn, null);
  assert.equal(ensemble[0].netAdaptiveExcessVsBenchmark, null);
  assert.equal(ensemble[0].weightedTopReturn, null);
  assert.deepEqual(ensemble[0].top, []);
  assert.equal(ensemble[0].scoredCount, 0);
  assert.equal(ensemble[0].skippedCount, 10);
});

test("walkForwardEnsembleOptimize risk weighting favors steadier sleeves over volatile winners", () => {
  const makeResult = (period, adaptiveReturn, excess, code) => {
    const [asOf, end] = period.split(":");
    const benchmarkReturnValue = adaptiveReturn - excess;
    const top = [{
      code,
      name: code,
      recommendedWeight: 1,
      recommendedWeightPct: 100,
      forwardReturn: adaptiveReturn,
      netForwardReturn: adaptiveReturn,
      benchmarkForwardReturn: benchmarkReturnValue,
      netBenchmarkForwardReturn: benchmarkReturnValue,
    }];
    return {
      asOf,
      end,
      top,
      adaptiveWeightedTopReturn: adaptiveReturn,
      netAdaptiveWeightedTopReturn: adaptiveReturn,
      weightedTopReturn: adaptiveReturn,
      netWeightedTopReturn: adaptiveReturn,
      topMeanReturn: adaptiveReturn,
      netTopMeanReturn: adaptiveReturn,
      weightedBenchmarkReturn: benchmarkReturnValue,
      netWeightedBenchmarkReturn: benchmarkReturnValue,
      benchmarkOverlayWeight: 0,
      adaptiveExcessVsBenchmark: excess,
      netAdaptiveExcessVsBenchmark: excess,
      weightedExcessVsBenchmark: excess,
      netWeightedExcessVsBenchmark: excess,
      adaptiveWeightedExcessReturn: excess,
      netAdaptiveWeightedExcessReturn: excess,
      universeMeanReturn: 0,
      netUniverseMeanReturn: 0,
      scoredCount: 10,
      skippedCount: 0,
    };
  };
  const periods = [
    "2026-01-01:2026-03-01",
    "2026-02-01:2026-04-01",
    "2026-03-01:2026-05-01",
    "2026-04-01:2026-06-01",
  ];
  const periodResultsByParam = new Map([
    ["high_return_high_drawdown", [
      makeResult(periods[0], 0.38, 0.20, "A"),
      makeResult(periods[1], -0.24, -0.30, "A"),
      makeResult(periods[2], 0.42, 0.22, "A"),
      makeResult(periods[3], -0.18, -0.20, "A"),
    ]],
    ["steady_positive", [
      makeResult(periods[0], 0.10, 0.05, "B"),
      makeResult(periods[1], 0.11, 0.05, "B"),
      makeResult(periods[2], 0.12, 0.05, "B"),
      makeResult(periods[3], 0.08, 0.05, "B"),
    ]],
  ]);

  const equal = walkForwardEnsembleOptimize(periodResultsByParam, { minTrainPeriods: 3, topK: 2, weighting: "equal" });
  const risk = walkForwardEnsembleOptimize(periodResultsByParam, { minTrainPeriods: 3, topK: 2, weighting: "risk" });

  assert.equal(risk.length, 1);
  assert.equal(risk[0].ensembleWeighting, "risk");
  const weightsByCode = new Map(risk[0].top.map((row) => [row.code, row.recommendedWeight]));
  assert.ok(weightsByCode.get("B") > weightsByCode.get("A"), `risk weights should favor steady sleeve: ${JSON.stringify(Array.from(weightsByCode))}`);
  assert.ok(risk[0].netAdaptiveWeightedTopReturn > equal[0].netAdaptiveWeightedTopReturn);
});
