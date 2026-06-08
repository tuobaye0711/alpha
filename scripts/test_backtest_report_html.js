const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "alpha_backtest.js"), "utf8");

test("HTML report uses responsive summary layout instead of fixed five columns", () => {
  assert.match(source, /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(160px,\s*1fr\)\)/);
  assert.doesNotMatch(source, /\.summary\s*\{[^}]*repeat\(5,\s*minmax\(0,\s*1fr\)\)/);
});

test("HTML report includes a mainstream index comparison table", () => {
  assert.match(source, /mainIndexSummaryRows/);
  assert.match(source, /id="indexTable"/);
  assert.match(source, /renderIndexTable/);
  assert.match(source, /上证指数/);
  assert.match(source, /深证成指/);
  assert.match(source, /中证500/);
  assert.match(source, /恒生指数/);
});

test("HTML report does not coerce missing index returns to zero", () => {
  assert.match(source, /function finiteNumber/);
  assert.match(source, /const ret = finiteNumber\(row.return\)/);
  assert.doesNotMatch(source, /const ret = Number\(row.return\)/);
});

test("HTML report exposes adaptive benchmark-overlay portfolio metrics", () => {
  assert.match(source, /adaptiveWeightedTopReturn/);
  assert.match(source, /benchmarkOverlayWeight/);
  assert.match(source, /defensiveCashWeight/);
  assert.match(source, /weakMarketCashWeight/);
  assert.match(source, /exhaustionCashWeight/);
  assert.match(source, /holdoutAdaptiveWeightedTopReturn/);
  assert.match(source, /自适应组合收益/);
  assert.match(source, /指数袖珍仓位/);
  assert.match(source, /现金仓位/);
  assert.match(source, /过热现金/);
});

test("HTML report exposes net returns after execution costs", () => {
  assert.match(source, /netAdaptiveWeightedTopReturn/);
  assert.match(source, /netWeightedTopReturn/);
  assert.match(source, /holdoutNetAdaptiveWeightedTopReturn/);
  assert.match(source, /executionCostRate/);
  assert.match(source, /净自适应收益/);
  assert.match(source, /净推荐收益/);
  assert.match(source, /留出净自适应收益/);
  assert.match(source, /交易成本/);
});

test("HTML report exposes exit-delay tradability metrics", () => {
  assert.match(source, /exitDelayDays/);
  assert.match(source, /exitDate/);
  assert.match(source, /退出顺延/);
  assert.match(source, /目标退出日/);
});

test("CLI and report expose dynamic point-in-time universe filters", () => {
  assert.match(source, /--universe-filter/);
  assert.match(source, /--min-universe-turnover/);
  assert.match(source, /--no-universe-filter/);
  assert.match(source, /universeFilter/);
  assert.match(source, /动态股票池/);
});

test("CLI and report expose dynamic group-strength universe filters", () => {
  assert.match(source, /--dynamic-group-filter/);
  assert.match(source, /--dynamic-group-by/);
  assert.match(source, /--min-dynamic-group-size/);
  assert.match(source, /--min-dynamic-group-score/);
  assert.match(source, /--min-dynamic-group-breadth/);
  assert.match(source, /--min-dynamic-group-remaining/);
  assert.match(source, /dynamicGroup/);
  assert.match(source, /动态行业\/主题强度/);
});

test("report writes and renders walk-forward parameter selection", () => {
  assert.match(source, /walk_forward_summary\.csv/);
  assert.match(source, /walkForwardRows/);
  assert.match(source, /id="walkForwardTable"/);
  assert.match(source, /Walk-forward/);
  assert.match(source, /trainingScore/);
  assert.match(source, /trainingAvgReturn/);
  assert.match(source, /训练稳健分/);
  assert.match(source, /训练收益/);
});

test("report writes and renders walk-forward top-k ensemble selection", () => {
  assert.match(source, /walk_forward_ensemble_summary\.csv/);
  assert.match(source, /walkForwardEnsembleRows/);
  assert.match(source, /id="walkForwardEnsembleTable"/);
  assert.match(source, /子策略组合/);
  assert.match(source, /selectedParams/);
  assert.match(source, /ensembleTopK/);
});

test("CLI exposes ensemble weighting sensitivity controls", () => {
  assert.match(source, /--ensemble-weighting/);
  assert.match(source, /equal\|score\|risk/);
  assert.match(source, /--ensemble-score-temperature/);
  assert.match(source, /ensembleWeighting/);
  assert.match(source, /ensembleScoreTemperature/);
});

test("CLI defaults to a single walk-forward strategy unless diversification is requested", () => {
  assert.match(source, /Walk-forward 子策略组合 TopK，默认 1/);
  assert.match(source, /ensembleTopK: 1/);
  assert.match(source, /args\.ensembleTopK === 1/);
  assert.match(source, /选择训练稳健分最高的单一参数 sleeve/);
});

test("CLI can optimize TopN candidate counts with walk-forward selection", () => {
  assert.match(source, /--top-values/);
  assert.match(source, /topValues/);
  assert.match(source, /topNOverride/);
  assert.match(source, /_top\$\{topN\}/);
});

test("CSV exports expose pullback accumulation diagnostics", () => {
  assert.match(source, /pullbackAccumulationScore/);
  assert.match(source, /pullbackDrawdown20/);
  assert.match(source, /pullbackSupportRatio20/);
  assert.match(source, /pullbackVolumeRatio5v20/);
  assert.match(source, /pullbackRankScore/);
});

test("CSV exports expose volume-confirmed momentum diagnostics", () => {
  assert.match(source, /volumeMomentumScore/);
  assert.match(source, /volumeTurnoverRatio5v20/);
  assert.match(source, /volumeMomentumRankScore/);
});

test("CSV exports expose benchmark-state rank diagnostics", () => {
  assert.match(source, /relativeMomentumRankScore/);
  assert.match(source, /benchmarkTrendRankScore/);
});

test("CSV exports expose 52-week high momentum diagnostics", () => {
  assert.match(source, /high52wScore/);
  assert.match(source, /high52wDistance/);
  assert.match(source, /high52wDaysSinceHigh/);
  assert.match(source, /high52wRankScore/);
});

test("CSV exports expose industry-residual momentum diagnostics", () => {
  assert.match(source, /industryResidualR20/);
  assert.match(source, /industryResidualR60/);
  assert.match(source, /industryResidualMomentumScore/);
  assert.match(source, /industryResidualRankScore/);
});

test("CSV exports expose dynamic group-strength diagnostics", () => {
  assert.match(source, /dynamicGroupKey/);
  assert.match(source, /dynamicGroupCount/);
  assert.match(source, /dynamicGroupScore/);
  assert.match(source, /dynamicGroupRankScore/);
  assert.match(source, /dynamicGroupBreadth20/);
});

test("CSV exports expose reversal-stability diagnostics", () => {
  assert.match(source, /shortTermReversalScore/);
  assert.match(source, /turnoverStabilityScore/);
  assert.match(source, /turnoverCv20/);
  assert.match(source, /shortTermReversalRankScore/);
  assert.match(source, /turnoverStabilityRankScore/);
});

test("CSV exports expose fresh-trend diagnostics", () => {
  assert.match(source, /freshTrendScore/);
  assert.match(source, /trendMaturityPenaltyScore/);
  assert.match(source, /freshTrendRankScore/);
});

test("CSV exports expose lottery-spike diagnostics", () => {
  assert.match(source, /maxDailyReturn20/);
  assert.match(source, /maxPositiveShare20/);
  assert.match(source, /lotterySpikeScore/);
  assert.match(source, /lotterySpikeRankScore/);
});

test("skipped CSV exports return-sanity diagnostics", () => {
  assert.match(source, /forwardReturn/);
  assert.match(source, /entryPrice/);
  assert.match(source, /exitPrice/);
  assert.match(source, /sanityMaxForwardReturn/);
  assert.match(source, /sanityJumpDate/);
  assert.match(source, /sanityPriceRatio/);
  assert.match(source, /sanityVolumeRatio/);
});

test("CLI keeps experimental pullback params out of default optimization", () => {
  assert.match(source, /--include-experimental-params/);
  assert.match(source, /includeExperimentalParams/);
  assert.match(source, /\.filter\(\(params\) => !params\.experimental\)/);
});

test("CLI exposes stable-baseline walk-forward incumbent policy", () => {
  assert.match(source, /--wf-incumbent-policy/);
  assert.match(source, /walkForwardIncumbentPolicy/);
  assert.match(source, /stable baseline/);
});

test("CLI and report expose walk-forward current basket gate diagnostics", () => {
  assert.match(source, /--wf-current-gate/);
  assert.match(source, /regime-v1/);
  assert.match(source, /regime-v12/);
  assert.match(source, /regime-v13/);
  assert.match(source, /walkForwardCurrentGate/);
  assert.match(source, /currentBasketGate/);
  assert.match(source, /当前篮子质量门禁/);
  assert.match(source, /currentGateReason/);
  assert.match(source, /Fresh差/);
});

test("CLI can restrict optimization to named parameter sets for factor isolation", () => {
  assert.match(source, /--param-names/);
  assert.match(source, /paramNames/);
  assert.match(source, /Unknown --param-names/);
});

test("CLI and report expose universe field leakage audit and static-theme sensitivity", () => {
  assert.match(source, /--no-static-theme/);
  assert.match(source, /--include-no-static-params/);
  assert.match(source, /noStaticTheme/);
  assert.match(source, /includeNoStaticParams/);
  assert.match(source, /_no_static_theme/);
  assert.match(source, /universe_field_audit\.csv/);
  assert.match(source, /universeFieldAudit/);
  assert.match(source, /当前快照字段审计/);
  assert.match(source, /静态主题\/行业信号/);
});

test("Tencent kline volume units are market-specific and do not multiply Shanghai shares", () => {
  assert.match(source, /function tencentVolumeUnit/);
  assert.match(source, /symbol\.startsWith\("sz"\)[\s\S]*return 100/);
  assert.match(source, /symbol\.startsWith\("bj"\)[\s\S]*return 100/);
  assert.match(source, /return 1;/);
  assert.doesNotMatch(source, /\/\^\(sh\|sz\|bj\)\//);
});

test("legacy Tencent Shanghai cache volumes are normalized before cache-only backtests", () => {
  assert.match(source, /TENCENT_VOLUME_UNIT_POLICY/);
  assert.match(source, /function normalizeCachedKlinePayload/);
  assert.match(source, /payload\.source === "tencent"/);
  assert.match(source, /symbol\.startsWith\("sh"\)/);
  assert.match(source, /Number\(row\.volume\) \/ 100/);
});
