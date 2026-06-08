const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyNameLookup,
  buildNameLookupFromRows,
  estimateExpectedExcessRange,
  explainSelection,
  formatHoldingPlan,
  futureEdgeProfile,
  rankByFutureEdge,
  renderHtmlReport,
  selectParamConfig,
} = require("./build_current_alpha_selection_report");

test("selectParamConfig resolves cloned topN names to the base parameter", () => {
  const result = selectParamConfig("rank_benchmark_state_attack_v32_top12");

  assert.equal(result.param.name, "rank_benchmark_state_attack_v32");
  assert.equal(result.topN, 12);
});

test("formatHoldingPlan includes weight, holding time and stock-specific excess-return expectation", () => {
  const row = {
    code: "300750",
    name: "宁德时代",
    market: "创业板",
    recommendedWeightPct: 9.5,
    score: 88,
    relativeR20: 0.12,
    volumeMomentumScore: 76,
    turnoverStabilityScore: 70,
    lotterySpikeScore: 91,
    freshTrendScore: 82,
    r20: 0.18,
    r60: 0.35,
    vol20: 0.42,
    avgTurnover20: 1200000000,
    entryDayReturn: 0.012,
  };

  const plan = formatHoldingPlan(row, { holdingPeriod: "6-8周" });

  assert.equal(plan.weightPct, "9.50%");
  assert.equal(plan.holdingPeriod, "6-8周");
  assert.match(plan.expectedExcess, /相对.*基准/);
  assert.match(plan.buyPlan, /分批/);
  assert.match(plan.riskControl, /跌破/);
});

test("estimateExpectedExcessRange varies with signal quality and risk", () => {
  const strong = estimateExpectedExcessRange({
    score: 90,
    relativeR20: 0.14,
    volumeMomentumScore: 82,
    turnoverStabilityScore: 78,
    lotterySpikeScore: 95,
    freshTrendScore: 88,
    vol20: 0.36,
  });
  const fragile = estimateExpectedExcessRange({
    score: 78,
    relativeR20: 0.01,
    volumeMomentumScore: 55,
    turnoverStabilityScore: 52,
    lotterySpikeScore: 72,
    freshTrendScore: 58,
    vol20: 0.95,
  });

  assert.notEqual(strong.label, fragile.label);
  assert.ok(strong.center > fragile.center);
});

test("future edge profile penalizes overheated recent winners", () => {
  const constructive = futureEdgeProfile({
    code: "300001",
    name: "温和启动",
    score: 80,
    r5: 0.025,
    r20: 0.105,
    r60: 0.22,
    relativeR20: 0.055,
    volumeMomentumScore: 72,
    turnoverStabilityScore: 76,
    freshTrendScore: 80,
    lotterySpikeScore: 92,
    maxDailyReturn20: 0.075,
    vol20: 0.45,
  });
  const overheated = futureEdgeProfile({
    code: "300002",
    name: "高位加速",
    score: 91,
    r5: 0.16,
    r20: 0.52,
    r60: 1.18,
    relativeR20: 0.44,
    volumeMomentumScore: 88,
    turnoverStabilityScore: 62,
    freshTrendScore: 55,
    lotterySpikeScore: 72,
    maxDailyReturn20: 0.16,
    vol20: 0.92,
  });

  assert.ok(constructive.futureEdgeScore > overheated.futureEdgeScore);
  assert.match(overheated.opportunityBucket, /不追/);
  assert.match(constructive.opportunityBucket, /试仓|回踩/);
});

test("rankByFutureEdge ranks future payoff ahead of raw momentum score", () => {
  const ranked = rankByFutureEdge([
    {
      code: "300002",
      name: "高位加速",
      score: 92,
      r5: 0.14,
      r20: 0.48,
      r60: 1.05,
      relativeR20: 0.39,
      volumeMomentumScore: 85,
      turnoverStabilityScore: 60,
      freshTrendScore: 56,
      lotterySpikeScore: 74,
      maxDailyReturn20: 0.15,
      vol20: 0.88,
    },
    {
      code: "300001",
      name: "温和启动",
      score: 79,
      r5: 0.03,
      r20: 0.11,
      r60: 0.24,
      relativeR20: 0.06,
      volumeMomentumScore: 73,
      turnoverStabilityScore: 74,
      freshTrendScore: 78,
      lotterySpikeScore: 90,
      maxDailyReturn20: 0.07,
      vol20: 0.46,
    },
  ]);

  assert.equal(ranked[0].name, "温和启动");
  assert.equal(ranked[0].modelScore, 79);
  assert.ok(ranked[0].futureEdgeScore > ranked[1].futureEdgeScore);
});

test("future edge profile caps ST stocks outside default attack candidates", () => {
  const st = futureEdgeProfile({
    code: "000826",
    name: "*ST启环",
    score: 90,
    r5: 0.02,
    r20: 0.10,
    r60: 0.22,
    relativeR20: 0.06,
    volumeMomentumScore: 80,
    turnoverStabilityScore: 82,
    freshTrendScore: 84,
    lotterySpikeScore: 92,
    maxDailyReturn20: 0.05,
    vol20: 0.42,
  });

  assert.ok(st.futureEdgeScore <= 35);
  assert.match(st.opportunityBucket, /剔除|降权/);
});

test("explainSelection prefers concrete technical reasons over generic text", () => {
  const row = {
    code: "300750",
    name: "宁德时代",
    market: "创业板",
    industry: "电池",
    theme: "出海|机器人",
    concepts: "固态电池|储能",
    relativeR20: 0.09,
    volumeMomentumScore: 81,
    turnoverStabilityScore: 75,
    lotterySpikeScore: 88,
    freshTrendScore: 84,
    r20: 0.16,
    r60: 0.28,
  };

  const reason = explainSelection(row);

  assert.match(reason, /20日相对强/);
  assert.match(reason, /量能确认/);
  assert.match(reason, /尖峰风险可控/);
});

test("name lookup repairs cache placeholder names and ignores cache source as theme", () => {
  const lookup = buildNameLookupFromRows([
    { code: "300308", name: "中际旭创", market: "创业板", industry: "通信设备" },
  ]);
  const [row] = applyNameLookup([
    {
      code: "300308",
      name: "sz300308",
      market: "深市",
      industry: "",
      theme: "cache_wide_a_share",
      relativeR20: 0.09,
      volumeMomentumScore: 81,
      turnoverStabilityScore: 75,
      lotterySpikeScore: 88,
      freshTrendScore: 84,
      r20: 0.16,
      r60: 0.28,
    },
  ], lookup);

  assert.equal(row.name, "中际旭创");
  assert.equal(row.market, "创业板");
  assert.equal(row.industry, "通信设备");
  assert.doesNotMatch(explainSelection(row), /cache_wide/);
});

test("renderHtmlReport contains portfolio allocation and risk notes", () => {
  const html = renderHtmlReport({
    title: "Alpha 当前选股",
    generatedAt: "2026-06-08T12:00:00.000Z",
    asOf: "2026-06-05",
    selectedPool: "merged",
    selectedParam: "rank_benchmark_state_attack_v32_top12",
    backtestSummary: {
      avgNetReturn: "18.06%",
      avgNetExcessBenchmark: "11.03%",
      pairedPValue: "0.121",
    },
    rows: [
      {
        rank: 1,
        code: "300750",
        name: "宁德时代",
        market: "创业板",
        industry: "电池",
        score: 88,
        priceAsOf: 210.5,
        r20: 0.16,
        r60: 0.28,
        relativeR20: 0.09,
        recommendedWeightPct: 9.5,
        reason: "20日相对强，量能确认，尖峰风险可控",
        weightPct: "9.50%",
        expectedExcess: "相对创业板指：+8%至+14%",
        holdingPeriod: "6-8周",
        buyPlan: "分批试仓",
        riskControl: "跌破20日线降仓",
      },
    ],
    caveats: ["不是收益承诺"],
  });

  assert.match(html, /Alpha 当前选股/);
  assert.match(html, /宁德时代/);
  assert.match(html, /9.50%/);
  assert.match(html, /6-8周/);
  assert.match(html, /近20交易日涨跌/);
  assert.match(html, /相对基准20日超额/);
  assert.match(html, /指最近20个交易日/);
  assert.match(html, /overflow-x:auto/);
  assert.match(html, /table-scroll/);
  assert.match(html, /overflow-wrap:anywhere/);
  assert.match(html, /word-break:break-all/);
  assert.match(html, /min-width:0/);
  assert.match(html, /\.legend \{ grid-template-columns:1fr; \}/);
  assert.match(html, /不是收益承诺/);
});
