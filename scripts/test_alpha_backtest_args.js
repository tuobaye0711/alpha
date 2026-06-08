const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { parseCsv } = require("./lib/backtest_engine");

function loadBacktestInternals() {
  const scriptPath = path.join(__dirname, "alpha_backtest.js");
  const source = fs.readFileSync(scriptPath, "utf8").replace(
    /main\(\)\.catch\(\(error\) => \{[\s\S]*?\n\}\);\s*$/,
    "module.exports = { parseArgs, paramsForRun, usage, parsePeriods, loadUniverseSet: typeof loadUniverseSet === \"function\" ? loadUniverseSet : undefined, prepareRunUniverses: typeof prepareRunUniverses === \"function\" ? prepareRunUniverses : undefined, runPoolSelectorMode: typeof runPoolSelectorMode === \"function\" ? runPoolSelectorMode : undefined, writeResultArtifacts: typeof writeResultArtifacts === \"function\" ? writeResultArtifacts : undefined };"
  );
  const module = { exports: {} };
  const sandbox = {
    __dirname: path.dirname(scriptPath),
    require,
    module,
    exports: module.exports,
    console,
    process: { exit: () => { throw new Error("unexpected process.exit"); } },
  };
  vm.runInNewContext(source, sandbox, { filename: scriptPath });
  return module.exports;
}

test("CLI can append only selected no-static parameter clones", () => {
  const { parseArgs, paramsForRun } = loadBacktestInternals();
  const args = parseArgs([
    "--param-names",
    [
      "balanced_reversal_stability_v51",
      "balanced_reversal_stability_mature_beta_rotation_stronger_v63",
      "balanced_reversal_stability_mature_beta_rotation_stronger_v63_no_static_theme",
    ].join(","),
    "--include-no-static-param-names",
    "balanced_reversal_stability_mature_beta_rotation_stronger_v63",
  ]);
  const names = paramsForRun(args).map((params) => params.name);

  assert.ok(names.includes("balanced_reversal_stability_v51"));
  assert.ok(names.includes("balanced_reversal_stability_mature_beta_rotation_stronger_v63"));
  assert.ok(names.includes("balanced_reversal_stability_mature_beta_rotation_stronger_v63_no_static_theme"));
  assert.equal(names.filter((name) => name.endsWith("_no_static_theme")).length, 1);
  assert.ok(!names.includes("balanced_reversal_stability_v51_no_static_theme"));
});

test("CLI rejects unknown selected no-static clone sources", () => {
  const { parseArgs, paramsForRun } = loadBacktestInternals();
  const args = parseArgs([
    "--include-no-static-param-names",
    "not_a_real_param",
  ]);

  assert.throws(
    () => paramsForRun(args),
    /Unknown --include-no-static-param-names: not_a_real_param/
  );
});

test("CLI keeps selected no-static clones when filtering by source param names", () => {
  const { parseArgs, paramsForRun } = loadBacktestInternals();
  const args = parseArgs([
    "--param-names",
    [
      "balanced_reversal_stability_v51",
      "balanced_reversal_stability_mature_beta_rotation_stronger_v63",
    ].join(","),
    "--include-no-static-param-names",
    "balanced_reversal_stability_mature_beta_rotation_stronger_v63",
  ]);
  const names = paramsForRun(args).map((params) => params.name);

  assert.deepEqual(names.sort(), [
    "balanced_reversal_stability_mature_beta_rotation_stronger_v63",
    "balanced_reversal_stability_mature_beta_rotation_stronger_v63_no_static_theme",
    "balanced_reversal_stability_v51",
  ].sort());
});

test("CLI accepts the latest walk-forward current gate", () => {
  const { parseArgs } = loadBacktestInternals();
  const args = parseArgs(["--wf-current-gate", "regime-v32"]);

  assert.equal(args.walkForwardCurrentGate, "regime-v32");
});

test("CLI parses pool selector options", () => {
  const { parseArgs } = loadBacktestInternals();
  const args = parseArgs([
    "--pool-selector-dirs",
    "physical=/tmp/physical,merged=/tmp/merged",
    "--pool-selector-lookback",
    "6",
    "--pool-selector-min-train",
    "6",
    "--pool-selector-initial",
    "merged",
    "--pool-selector-score-excess-weight",
    "0.35",
    "--pool-selector-baseline",
    "merged",
    "--pool-selector-current-feature-gate",
    "physical-relative-v1",
    "--pool-selector-include-warmup",
  ]);

  assert.equal(JSON.stringify(args.poolSelectorDirs.map((pool) => pool.name)), JSON.stringify(["physical", "merged"]));
  assert.equal(JSON.stringify(args.poolSelectorDirs.map((pool) => pool.dir)), JSON.stringify(["/tmp/physical", "/tmp/merged"]));
  assert.equal(args.poolSelectorLookback, 6);
  assert.equal(args.poolSelectorMinTrain, 6);
  assert.equal(args.poolSelectorInitialPool, "merged");
  assert.equal(args.poolSelectorScoreExcessWeight, 0.35);
  assert.equal(args.poolSelectorBaselinePool, "merged");
  assert.equal(args.poolSelectorCurrentFeatureGate, "physical-relative-v1");
  assert.equal(args.poolSelectorIncludeWarmup, true);
});

test("CLI parses walk-forward feature gate mode", () => {
  const { parseArgs } = loadBacktestInternals();
  const args = parseArgs([
    "--pool-selector-dirs",
    "physical=/tmp/physical,merged=/tmp/merged",
    "--pool-selector-current-feature-gate",
    "physical-relative-wf-v1",
    "--pool-selector-baseline",
    "merged",
  ]);

  assert.equal(args.poolSelectorCurrentFeatureGate, "physical-relative-wf-v1");
});

test("CLI parses offline training data options", () => {
  const { parseArgs } = loadBacktestInternals();
  const args = parseArgs([
    "--offline-data",
    "--offline-data-dir",
    "/tmp/alpha-offline",
    "--qlib-dir",
    "/tmp/alpha-offline/qlib_bin",
    "--hk-connect-history-dir",
    "/tmp/alpha-offline/hk",
  ]);

  assert.equal(args.offlineData, true);
  assert.equal(args.offlineOnly, false);
  assert.equal(args.offlineDataDir, "/tmp/alpha-offline");
  assert.equal(args.qlibDir, "/tmp/alpha-offline/qlib_bin");
  assert.equal(args.hkConnectHistoryDir, "/tmp/alpha-offline/hk");
});

test("CLI offline-only enables local-only execution", () => {
  const { parseArgs } = loadBacktestInternals();
  const args = parseArgs(["--offline-only"]);

  assert.equal(args.offlineData, true);
  assert.equal(args.offlineOnly, true);
  assert.equal(args.cacheOnly, true);
});

function writeUniverseCsv(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const headers = ["theme", "code", "name", "market", "source"];
  fs.writeFileSync(
    file,
    [
      headers.join(","),
      ...rows.map((row) => headers.map((header) => row[header] || "").join(",")),
    ].join("\n")
  );
}

test("CLI can load per-asOf period universes and keep per-code fetch windows", () => {
  const { parseArgs, parsePeriods, loadUniverseSet, prepareRunUniverses } = loadBacktestInternals();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-period-universe-"));
  writeUniverseCsv(path.join(tmp, "pit_universe_2026-04-01.csv"), [
    { theme: "pit", code: "000001", name: "A", market: "深市", source: "pit_asof_2026-04-01" },
    { theme: "pit", code: "000002", name: "B", market: "深市", source: "pit_asof_2026-04-01" },
  ]);
  writeUniverseCsv(path.join(tmp, "pit_universe_2026-05-04.csv"), [
    { theme: "pit", code: "000002", name: "B", market: "深市", source: "pit_asof_2026-05-04" },
    { theme: "pit", code: "000003", name: "C", market: "沪市", source: "pit_asof_2026-05-04" },
  ]);

  const args = parseArgs([
    "--period-universe-dir",
    tmp,
    "--periods",
    "2026-04-01:2026-06-01,2026-05-04:2026-07-01",
  ]);
  const periods = parsePeriods(args.periods);
  const universeSet = loadUniverseSet(args, periods);
  const prepared = prepareRunUniverses(args, periods, universeSet);

  assert.equal(args.periodUniverseDir, tmp);
  assert.equal(typeof loadUniverseSet, "function");
  assert.equal(typeof prepareRunUniverses, "function");
  assert.equal(universeSet.mode, "period");
  assert.equal(universeSet.universeFiles.length, 2);
  assert.equal(
    JSON.stringify(prepared.periodUniverseRowsByKey.get("2026-04-01:2026-06-01").map((row) => row.code)),
    JSON.stringify(["000001", "000002"])
  );
  assert.equal(
    JSON.stringify(prepared.periodUniverseRowsByKey.get("2026-05-04:2026-07-01").map((row) => row.code)),
    JSON.stringify(["000002", "000003"])
  );
  assert.equal(JSON.stringify(prepared.fetchUniverse.map((row) => row.code)), JSON.stringify(["000001", "000002", "000003"]));
  assert.equal(JSON.stringify(prepared.fetchWindowByCode.get("000001")), JSON.stringify({ minAsOf: "2026-04-01", maxEnd: "2026-06-01" }));
  assert.equal(JSON.stringify(prepared.fetchWindowByCode.get("000002")), JSON.stringify({ minAsOf: "2026-04-01", maxEnd: "2026-07-01" }));
  assert.equal(JSON.stringify(prepared.fetchWindowByCode.get("000003")), JSON.stringify({ minAsOf: "2026-05-04", maxEnd: "2026-07-01" }));
});

function writeWalkForwardSummary(dir, rows) {
  fs.mkdirSync(dir, { recursive: true });
  const headers = [
    "periodIndex",
    "period",
    "asOf",
    "end",
    "selectedParam",
    "netAdaptiveWeightedTopReturn",
    "netAdaptiveExcessVsBenchmark",
    "netAdaptiveWeightedExcessReturn",
  ];
  const lines = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => row[header]).join(",")),
  ];
  fs.writeFileSync(path.join(dir, "walk_forward_summary.csv"), lines.join("\n"));
}

function writeTop10(dir, period, rows) {
  fs.mkdirSync(dir, { recursive: true });
  const [asOf, end] = period.split(":");
  const headers = [
    "rank",
    "code",
    "name",
    "recommendedWeight",
    "netForwardReturn",
    "relativeMomentumScore",
    "relativeR20",
    "relativeR60",
    "r60",
    "benchmarkR20",
    "benchmarkR60",
    "freshTrendScore",
    "lotterySpikeScore",
    "volumeMomentumScore",
    "volumeTurnoverRatio5v20",
    "turnoverStabilityScore",
    "entryDayReturn",
  ];
  const lines = [
    headers.join(","),
    ...rows.map((row, index) => headers.map((header) => row[header] ?? (header === "rank" ? index + 1 : "")).join(",")),
  ];
  fs.writeFileSync(path.join(dir, `top10_${asOf}_${end}.csv`), lines.join("\n"));
}

function writeWalkForwardTop10(dir, period, rows) {
  fs.mkdirSync(dir, { recursive: true });
  const [asOf, end] = period.split(":");
  const headers = [
    "rank",
    "code",
    "name",
    "recommendedWeight",
    "netForwardReturn",
    "relativeMomentumScore",
    "relativeR20",
    "relativeR60",
    "r60",
    "benchmarkR20",
    "benchmarkR60",
    "freshTrendScore",
    "lotterySpikeScore",
    "volumeMomentumScore",
    "volumeTurnoverRatio5v20",
    "turnoverStabilityScore",
    "entryDayReturn",
  ];
  const lines = [
    headers.join(","),
    ...rows.map((row, index) => headers.map((header) => row[header] ?? (header === "rank" ? index + 1 : "")).join(",")),
  ];
  fs.writeFileSync(path.join(dir, `walk_forward_top10_${asOf}_${end}.csv`), lines.join("\n"));
}

test("pool selector mode writes prior-window pool selection artifacts", () => {
  const { parseArgs, runPoolSelectorMode } = loadBacktestInternals();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-pool-selector-"));
  const physicalDir = path.join(tmp, "physical");
  const mergedDir = path.join(tmp, "merged");
  const outDir = path.join(tmp, "out");

  writeWalkForwardSummary(physicalDir, [
    { periodIndex: 0, period: "2026-01-01:2026-02-01", asOf: "2026-01-01", end: "2026-02-01", selectedParam: "p", netAdaptiveWeightedTopReturn: 0.01, netAdaptiveExcessVsBenchmark: 0.01, netAdaptiveWeightedExcessReturn: 0.005 },
    { periodIndex: 1, period: "2026-02-01:2026-03-01", asOf: "2026-02-01", end: "2026-03-01", selectedParam: "p", netAdaptiveWeightedTopReturn: 0.01, netAdaptiveExcessVsBenchmark: 0.01, netAdaptiveWeightedExcessReturn: 0.005 },
    { periodIndex: 2, period: "2026-03-01:2026-04-01", asOf: "2026-03-01", end: "2026-04-01", selectedParam: "p", netAdaptiveWeightedTopReturn: 0.04, netAdaptiveExcessVsBenchmark: 0.03, netAdaptiveWeightedExcessReturn: 0.02 },
  ]);
  writeWalkForwardSummary(mergedDir, [
    { periodIndex: 0, period: "2026-01-01:2026-02-01", asOf: "2026-01-01", end: "2026-02-01", selectedParam: "m", netAdaptiveWeightedTopReturn: 0.10, netAdaptiveExcessVsBenchmark: 0.08, netAdaptiveWeightedExcessReturn: 0.04 },
    { periodIndex: 1, period: "2026-02-01:2026-03-01", asOf: "2026-02-01", end: "2026-03-01", selectedParam: "m", netAdaptiveWeightedTopReturn: 0.10, netAdaptiveExcessVsBenchmark: 0.08, netAdaptiveWeightedExcessReturn: 0.04 },
    { periodIndex: 2, period: "2026-03-01:2026-04-01", asOf: "2026-03-01", end: "2026-04-01", selectedParam: "m", netAdaptiveWeightedTopReturn: 0.02, netAdaptiveExcessVsBenchmark: 0.01, netAdaptiveWeightedExcessReturn: 0.005 },
  ]);

  const args = parseArgs([
    "--pool-selector-dirs",
    `physical=${physicalDir},merged=${mergedDir}`,
    "--pool-selector-min-train",
    "2",
    "--pool-selector-lookback",
    "2",
    "--pool-selector-initial",
    "physical",
    "--pool-selector-baseline",
    "merged",
    "--pool-selector-include-warmup",
    "--out-dir",
    outDir,
  ]);

  assert.equal(typeof runPoolSelectorMode, "function");
  runPoolSelectorMode(args);

  const csv = fs.readFileSync(path.join(outDir, "walk_forward_pool_selector_summary.csv"), "utf8");
  assert.match(csv, /selectedPool/);
  assert.match(csv, /warmup_initial_pool/);
  assert.match(csv, /selected_by_prior_pool_score/);
  assert.match(csv, /merged/);

  const summary = JSON.parse(fs.readFileSync(path.join(outDir, "pool_selector_summary.json"), "utf8"));
  assert.equal(summary.rowCount, 3);
  assert.equal(summary.summary.avgNetAdaptiveWeightedTopReturn, 0.013333);
  assert.equal(summary.summary.hitCountVsBenchmark, 3);
  assert.equal(summary.warmupRowCount, 2);
  assert.equal(summary.trainedSummary.rowCount, 1);
  assert.equal(summary.trainedSummary.avgNetAdaptiveWeightedTopReturn, 0.02);
  assert.equal(summary.fixedPoolSummaries.merged.avgNetAdaptiveWeightedTopReturn, 0.073333);
  assert.equal(summary.baselineComparison.baselinePool, "merged");
  assert.equal(summary.baselineComparison.rowCount, 3);
  assert.equal(summary.baselineComparison.avgReturnDelta, -0.06);
  assert.equal(summary.baselineComparison.hitCountVsBaseline, 0);
  assert.equal(summary.baselineComparison.worstReturnDelta, -0.09);
  assert.equal(summary.baselineComparison.latestReturnDelta, 0);
  assert.equal(summary.baselineComparison.pairedReturnTStat, -2);
  assert.ok(summary.baselineComparison.pairedReturnPValueApprox < 0.06);
  assert.equal(summary.trainedBaselineComparison.rowCount, 1);
  assert.equal(summary.trainedBaselineComparison.avgReturnDelta, 0);
});

test("pool selector current risk gate blocks fragile PIT switch from prior returns", () => {
  const { parseArgs, runPoolSelectorMode } = loadBacktestInternals();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-pool-risk-gate-"));
  const pitSzDir = path.join(tmp, "pitSz");
  const mergedDir = path.join(tmp, "merged");
  const outDir = path.join(tmp, "out");
  const periods = [
    "2026-01-01:2026-01-15",
    "2026-02-01:2026-02-15",
    "2026-03-01:2026-03-15",
    "2026-04-01:2026-04-15",
  ];

  writeWalkForwardSummary(pitSzDir, [
    { periodIndex: 0, period: periods[0], asOf: "2026-01-01", end: "2026-01-15", selectedParam: "pit", netAdaptiveWeightedTopReturn: 0.20, netAdaptiveExcessVsBenchmark: 0.18, netAdaptiveWeightedExcessReturn: 0.12 },
    { periodIndex: 1, period: periods[1], asOf: "2026-02-01", end: "2026-02-15", selectedParam: "pit", netAdaptiveWeightedTopReturn: 0.22, netAdaptiveExcessVsBenchmark: 0.20, netAdaptiveWeightedExcessReturn: 0.14 },
    { periodIndex: 2, period: periods[2], asOf: "2026-03-01", end: "2026-03-15", selectedParam: "pit", netAdaptiveWeightedTopReturn: 0.21, netAdaptiveExcessVsBenchmark: 0.19, netAdaptiveWeightedExcessReturn: 0.13 },
    { periodIndex: 3, period: periods[3], asOf: "2026-04-01", end: "2026-04-15", selectedParam: "pit", netAdaptiveWeightedTopReturn: -0.10, netAdaptiveExcessVsBenchmark: -0.12, netAdaptiveWeightedExcessReturn: -0.08 },
  ]);
  writeWalkForwardSummary(mergedDir, [
    { periodIndex: 0, period: periods[0], asOf: "2026-01-01", end: "2026-01-15", selectedParam: "m", netAdaptiveWeightedTopReturn: 0.05, netAdaptiveExcessVsBenchmark: 0.04, netAdaptiveWeightedExcessReturn: 0.02 },
    { periodIndex: 1, period: periods[1], asOf: "2026-02-01", end: "2026-02-15", selectedParam: "m", netAdaptiveWeightedTopReturn: 0.06, netAdaptiveExcessVsBenchmark: 0.05, netAdaptiveWeightedExcessReturn: 0.03 },
    { periodIndex: 2, period: periods[2], asOf: "2026-03-01", end: "2026-03-15", selectedParam: "m", netAdaptiveWeightedTopReturn: 0.07, netAdaptiveExcessVsBenchmark: 0.06, netAdaptiveWeightedExcessReturn: 0.04 },
    { periodIndex: 3, period: periods[3], asOf: "2026-04-01", end: "2026-04-15", selectedParam: "m", netAdaptiveWeightedTopReturn: 0.08, netAdaptiveExcessVsBenchmark: 0.07, netAdaptiveWeightedExcessReturn: 0.05 },
  ]);
  for (const [index, period] of periods.entries()) {
    const fragileCurrent = index === 3;
    writeTop10(pitSzDir, period, [
      { code: "p1", name: "P1", r60: fragileCurrent ? 0.30 : 0.50, relativeR60: fragileCurrent ? 0.25 : 0.42, benchmarkR60: fragileCurrent ? 0.10 : 0.20, freshTrendScore: fragileCurrent ? 80 : 82, lotterySpikeScore: fragileCurrent ? 98 : 88, relativeMomentumScore: 75, relativeR20: 0.05, benchmarkR20: 0.10, volumeMomentumScore: 80, volumeTurnoverRatio5v20: 1.2, turnoverStabilityScore: 62, entryDayReturn: 0.01 },
      { code: "p2", name: "P2", r60: fragileCurrent ? 0.32 : 0.52, relativeR60: fragileCurrent ? 0.27 : 0.44, benchmarkR60: fragileCurrent ? 0.10 : 0.20, freshTrendScore: fragileCurrent ? 82 : 84, lotterySpikeScore: fragileCurrent ? 98 : 88, relativeMomentumScore: 76, relativeR20: 0.05, benchmarkR20: 0.10, volumeMomentumScore: 81, volumeTurnoverRatio5v20: 1.2, turnoverStabilityScore: 64, entryDayReturn: 0.01 },
    ]);
    writeTop10(mergedDir, period, [
      { code: "m1", name: "M1", r60: 0.55, relativeR60: 0.38, benchmarkR60: 0.30, freshTrendScore: 68, lotterySpikeScore: 84, relativeMomentumScore: 72, relativeR20: 0.04, benchmarkR20: 0.18, volumeMomentumScore: 75, volumeTurnoverRatio5v20: 1.1, turnoverStabilityScore: 64, entryDayReturn: 0.01 },
      { code: "m2", name: "M2", r60: 0.57, relativeR60: 0.40, benchmarkR60: 0.30, freshTrendScore: 70, lotterySpikeScore: 84, relativeMomentumScore: 73, relativeR20: 0.04, benchmarkR20: 0.18, volumeMomentumScore: 76, volumeTurnoverRatio5v20: 1.1, turnoverStabilityScore: 66, entryDayReturn: 0.01 },
    ]);
  }

  const args = parseArgs([
    "--pool-selector-dirs",
    `pitSz=${pitSzDir},merged=${mergedDir}`,
    "--pool-selector-min-train",
    "1",
    "--pool-selector-lookback",
    "3",
    "--pool-selector-known-outcome-only",
    "--pool-selector-baseline",
    "merged",
    "--pool-selector-current-risk-gate",
    "relative-trend-crowding-v1",
    "--out-dir",
    outDir,
  ]);

  runPoolSelectorMode(args);

  const csv = fs.readFileSync(path.join(outDir, "walk_forward_pool_selector_summary.csv"), "utf8");
  assert.match(csv, /riskGateMode/);
  assert.match(csv, /blocked_by_current_risk_gate/);

  const summary = JSON.parse(fs.readFileSync(path.join(outDir, "pool_selector_summary.json"), "utf8"));
  assert.equal(summary.options.currentRiskGate, "relative-trend-crowding-v1");
  assert.equal(summary.summary.selectedPoolCounts.merged, 1);
  assert.equal(summary.summary.selectedPoolCounts.pitSz, 2);
  assert.equal(summary.baselineComparison.avgReturnDelta, 0.1);
  assert.equal(summary.baselineComparison.worstReturnDelta, 0);
});

test("pool selector current risk gate v2 blocks stale crowded PIT switch", () => {
  const { parseArgs, runPoolSelectorMode } = loadBacktestInternals();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-pool-risk-gate-v2-"));
  const pitSzDir = path.join(tmp, "pitSz");
  const mergedDir = path.join(tmp, "merged");
  const periods = [
    "2026-03-01:2026-03-15",
    "2026-04-01:2026-04-15",
  ];

  writeWalkForwardSummary(pitSzDir, [
    { periodIndex: 0, period: periods[0], asOf: "2026-03-01", end: "2026-03-15", selectedParam: "pit", netAdaptiveWeightedTopReturn: 0.24, netAdaptiveExcessVsBenchmark: 0.22, netAdaptiveWeightedExcessReturn: 0.18 },
    { periodIndex: 1, period: periods[1], asOf: "2026-04-01", end: "2026-04-15", selectedParam: "pit", netAdaptiveWeightedTopReturn: -0.02, netAdaptiveExcessVsBenchmark: -0.04, netAdaptiveWeightedExcessReturn: -0.03 },
  ]);
  writeWalkForwardSummary(mergedDir, [
    { periodIndex: 0, period: periods[0], asOf: "2026-03-01", end: "2026-03-15", selectedParam: "m", netAdaptiveWeightedTopReturn: 0.08, netAdaptiveExcessVsBenchmark: 0.06, netAdaptiveWeightedExcessReturn: 0.04 },
    { periodIndex: 1, period: periods[1], asOf: "2026-04-01", end: "2026-04-15", selectedParam: "m", netAdaptiveWeightedTopReturn: 0.05, netAdaptiveExcessVsBenchmark: 0.03, netAdaptiveWeightedExcessReturn: 0.02 },
  ]);
  for (const period of periods) {
    writeTop10(pitSzDir, period, [
      { code: "p1", name: "P1", r60: 0.70, relativeR60: 0.55, benchmarkR60: 0.12, freshTrendScore: 42, lotterySpikeScore: 94, relativeMomentumScore: 78, relativeR20: 0.08, benchmarkR20: 0.10, volumeMomentumScore: 80, volumeTurnoverRatio5v20: 1.2, turnoverStabilityScore: 72, entryDayReturn: 0.01 },
      { code: "p2", name: "P2", r60: 0.72, relativeR60: 0.57, benchmarkR60: 0.12, freshTrendScore: 44, lotterySpikeScore: 94, relativeMomentumScore: 79, relativeR20: 0.08, benchmarkR20: 0.10, volumeMomentumScore: 81, volumeTurnoverRatio5v20: 1.2, turnoverStabilityScore: 74, entryDayReturn: 0.01 },
    ]);
    writeTop10(mergedDir, period, [
      { code: "m1", name: "M1", r60: 0.55, relativeR60: 0.38, benchmarkR60: 0.16, freshTrendScore: 65, lotterySpikeScore: 84, relativeMomentumScore: 72, relativeR20: 0.04, benchmarkR20: 0.14, volumeMomentumScore: 75, volumeTurnoverRatio5v20: 1.1, turnoverStabilityScore: 64, entryDayReturn: 0.01 },
      { code: "m2", name: "M2", r60: 0.57, relativeR60: 0.40, benchmarkR60: 0.16, freshTrendScore: 67, lotterySpikeScore: 84, relativeMomentumScore: 73, relativeR20: 0.04, benchmarkR20: 0.14, volumeMomentumScore: 76, volumeTurnoverRatio5v20: 1.1, turnoverStabilityScore: 66, entryDayReturn: 0.01 },
    ]);
  }

  for (const mode of ["relative-trend-crowding-v2", "relative-trend-crowding-v3"]) {
    const outDir = path.join(tmp, mode);
    const args = parseArgs([
      "--pool-selector-dirs",
      `pitSz=${pitSzDir},merged=${mergedDir}`,
      "--pool-selector-min-train",
      "1",
      "--pool-selector-lookback",
      "1",
      "--pool-selector-known-outcome-only",
      "--pool-selector-baseline",
      "merged",
      "--pool-selector-current-risk-gate",
      mode,
      "--out-dir",
      outDir,
    ]);

    runPoolSelectorMode(args);

    const csv = fs.readFileSync(path.join(outDir, "walk_forward_pool_selector_summary.csv"), "utf8");
    assert.match(csv, /stale_crowding_without_fresh_confirmation/);

    const summary = JSON.parse(fs.readFileSync(path.join(outDir, "pool_selector_summary.json"), "utf8"));
    assert.equal(summary.options.currentRiskGate, mode);
    assert.equal(summary.summary.selectedPoolCounts.merged, 1);
    assert.equal(summary.baselineComparison.avgReturnDelta, 0);
    assert.equal(summary.baselineComparison.worstReturnDelta, 0);
  }
});

test("pool selector current risk gate v3 requires fresh confirmation or risk reduction", () => {
  const { parseArgs, runPoolSelectorMode } = loadBacktestInternals();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-pool-risk-gate-v3-"));
  const pitSzDir = path.join(tmp, "pitSz");
  const mergedDir = path.join(tmp, "merged");
  const outDir = path.join(tmp, "out");
  const periods = [
    "2026-01-01:2026-01-15",
    "2026-02-01:2026-02-15",
  ];

  writeWalkForwardSummary(pitSzDir, [
    { periodIndex: 0, period: periods[0], asOf: "2026-01-01", end: "2026-01-15", selectedParam: "pit", netAdaptiveWeightedTopReturn: 0.20, netAdaptiveExcessVsBenchmark: 0.18, netAdaptiveWeightedExcessReturn: 0.12 },
    { periodIndex: 1, period: periods[1], asOf: "2026-02-01", end: "2026-02-15", selectedParam: "pit", netAdaptiveWeightedTopReturn: -0.01, netAdaptiveExcessVsBenchmark: -0.02, netAdaptiveWeightedExcessReturn: -0.02 },
  ]);
  writeWalkForwardSummary(mergedDir, [
    { periodIndex: 0, period: periods[0], asOf: "2026-01-01", end: "2026-01-15", selectedParam: "m", netAdaptiveWeightedTopReturn: 0.06, netAdaptiveExcessVsBenchmark: 0.05, netAdaptiveWeightedExcessReturn: 0.03 },
    { periodIndex: 1, period: periods[1], asOf: "2026-02-01", end: "2026-02-15", selectedParam: "m", netAdaptiveWeightedTopReturn: 0.04, netAdaptiveExcessVsBenchmark: 0.03, netAdaptiveWeightedExcessReturn: 0.02 },
  ]);
  for (const period of periods) {
    writeTop10(pitSzDir, period, [
      { code: "p1", name: "P1", r60: 0.72, relativeR60: 0.51, benchmarkR60: 0.18, freshTrendScore: 61, lotterySpikeScore: 86, relativeMomentumScore: 78, relativeR20: 0.08, benchmarkR20: 0.10, volumeMomentumScore: 80, volumeTurnoverRatio5v20: 1.2, turnoverStabilityScore: 66, entryDayReturn: 0.01 },
      { code: "p2", name: "P2", r60: 0.74, relativeR60: 0.53, benchmarkR60: 0.18, freshTrendScore: 63, lotterySpikeScore: 86, relativeMomentumScore: 79, relativeR20: 0.08, benchmarkR20: 0.10, volumeMomentumScore: 81, volumeTurnoverRatio5v20: 1.2, turnoverStabilityScore: 68, entryDayReturn: 0.01 },
    ]);
    writeTop10(mergedDir, period, [
      { code: "m1", name: "M1", r60: 0.58, relativeR60: 0.42, benchmarkR60: 0.15, freshTrendScore: 68, lotterySpikeScore: 85, relativeMomentumScore: 72, relativeR20: 0.04, benchmarkR20: 0.14, volumeMomentumScore: 75, volumeTurnoverRatio5v20: 1.1, turnoverStabilityScore: 67, entryDayReturn: 0.01 },
      { code: "m2", name: "M2", r60: 0.60, relativeR60: 0.44, benchmarkR60: 0.15, freshTrendScore: 70, lotterySpikeScore: 85, relativeMomentumScore: 73, relativeR20: 0.04, benchmarkR20: 0.14, volumeMomentumScore: 76, volumeTurnoverRatio5v20: 1.1, turnoverStabilityScore: 69, entryDayReturn: 0.01 },
    ]);
  }

  const args = parseArgs([
    "--pool-selector-dirs",
    `pitSz=${pitSzDir},merged=${mergedDir}`,
    "--pool-selector-min-train",
    "1",
    "--pool-selector-lookback",
    "1",
    "--pool-selector-known-outcome-only",
    "--pool-selector-baseline",
    "merged",
    "--pool-selector-current-risk-gate",
    "relative-trend-crowding-v3",
    "--out-dir",
    outDir,
  ]);

  runPoolSelectorMode(args);

  const csv = fs.readFileSync(path.join(outDir, "walk_forward_pool_selector_summary.csv"), "utf8");
  assert.match(csv, /fresh_confirmation_missing/);

  const summary = JSON.parse(fs.readFileSync(path.join(outDir, "pool_selector_summary.json"), "utf8"));
  assert.equal(summary.options.currentRiskGate, "relative-trend-crowding-v3");
  assert.equal(summary.summary.selectedPoolCounts.merged, 1);
  assert.equal(summary.baselineComparison.avgReturnDelta, 0);
  assert.equal(summary.baselineComparison.worstReturnDelta, 0);
});

test("pool selector current risk gate v5 blocks soft relative weakness without risk reduction", () => {
  const { parseArgs, runPoolSelectorMode } = loadBacktestInternals();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-pool-risk-gate-v5-"));
  const pitShDir = path.join(tmp, "pitSh");
  const pitSzDir = path.join(tmp, "pitSz");
  const periods = [
    "2026-01-01:2026-01-15",
    "2026-02-01:2026-02-15",
  ];

  writeWalkForwardSummary(pitShDir, [
    { periodIndex: 0, period: periods[0], asOf: "2026-01-01", end: "2026-01-15", selectedParam: "sh", netAdaptiveWeightedTopReturn: 0.20, netAdaptiveExcessVsBenchmark: 0.18, netAdaptiveWeightedExcessReturn: 0.14 },
    { periodIndex: 1, period: periods[1], asOf: "2026-02-01", end: "2026-02-15", selectedParam: "sh", netAdaptiveWeightedTopReturn: -0.03, netAdaptiveExcessVsBenchmark: -0.04, netAdaptiveWeightedExcessReturn: -0.03 },
  ]);
  writeWalkForwardSummary(pitSzDir, [
    { periodIndex: 0, period: periods[0], asOf: "2026-01-01", end: "2026-01-15", selectedParam: "sz", netAdaptiveWeightedTopReturn: 0.05, netAdaptiveExcessVsBenchmark: 0.04, netAdaptiveWeightedExcessReturn: 0.03 },
    { periodIndex: 1, period: periods[1], asOf: "2026-02-01", end: "2026-02-15", selectedParam: "sz", netAdaptiveWeightedTopReturn: 0.04, netAdaptiveExcessVsBenchmark: 0.03, netAdaptiveWeightedExcessReturn: 0.02 },
  ]);
  for (const period of periods) {
    writeTop10(pitShDir, period, [
      { code: "sh1", name: "SH1", r60: 0.46, relativeR60: 0.36, benchmarkR60: 0.10, freshTrendScore: 68, lotterySpikeScore: 88, relativeMomentumScore: 76, relativeR20: 0.08, benchmarkR20: 0.10, volumeMomentumScore: 74, volumeTurnoverRatio5v20: 1.2, turnoverStabilityScore: 76, entryDayReturn: 0.01 },
      { code: "sh2", name: "SH2", r60: 0.48, relativeR60: 0.38, benchmarkR60: 0.10, freshTrendScore: 70, lotterySpikeScore: 90, relativeMomentumScore: 78, relativeR20: 0.08, benchmarkR20: 0.10, volumeMomentumScore: 76, volumeTurnoverRatio5v20: 1.2, turnoverStabilityScore: 78, entryDayReturn: 0.01 },
    ]);
    writeTop10(pitSzDir, period, [
      { code: "sz1", name: "SZ1", r60: 0.50, relativeR60: 0.40, benchmarkR60: 0.10, freshTrendScore: 70, lotterySpikeScore: 84, relativeMomentumScore: 78, relativeR20: 0.08, benchmarkR20: 0.10, volumeMomentumScore: 74, volumeTurnoverRatio5v20: 1.1, turnoverStabilityScore: 68, entryDayReturn: 0.01 },
      { code: "sz2", name: "SZ2", r60: 0.52, relativeR60: 0.42, benchmarkR60: 0.10, freshTrendScore: 72, lotterySpikeScore: 86, relativeMomentumScore: 80, relativeR20: 0.08, benchmarkR20: 0.10, volumeMomentumScore: 76, volumeTurnoverRatio5v20: 1.1, turnoverStabilityScore: 70, entryDayReturn: 0.01 },
    ]);
  }

  const runMode = (mode) => {
    const outDir = path.join(tmp, mode);
    const args = parseArgs([
      "--pool-selector-dirs",
      `pitSh=${pitShDir},pitSz=${pitSzDir}`,
      "--pool-selector-min-train",
      "1",
      "--pool-selector-lookback",
      "1",
      "--pool-selector-known-outcome-only",
      "--pool-selector-baseline",
      "pitSz",
      "--pool-selector-current-risk-gate",
      mode,
      "--out-dir",
      outDir,
    ]);
    runPoolSelectorMode(args);
    return {
      rows: parseCsv(fs.readFileSync(path.join(outDir, "walk_forward_pool_selector_summary.csv"), "utf8")),
      summary: JSON.parse(fs.readFileSync(path.join(outDir, "pool_selector_summary.json"), "utf8")),
    };
  };

  const v3 = runMode("relative-trend-crowding-v3");
  assert.equal(v3.rows.length, 1);
  assert.equal(v3.rows[0].selectedPool, "pitSh");
  assert.equal(v3.rows[0].riskGateReason, "current_risk_gate_passed");
  assert.equal(v3.summary.baselineComparison.avgReturnDelta, -0.07);
  assert.equal(v3.summary.baselineComparison.worstReturnDelta, -0.07);

  const v5 = runMode("relative-trend-crowding-v5");
  assert.equal(v5.rows.length, 1);
  assert.equal(v5.rows[0].selectedPool, "pitSz");
  assert.equal(v5.rows[0].poolSelectionReason, "blocked_by_current_risk_gate");
  assert.equal(v5.rows[0].riskGateReason, "soft_relative_trend_weak_without_risk_reduction");
  assert.equal(v5.rows[0].riskGateBlockedPool, "pitSh");
  assert.equal(v5.summary.options.currentRiskGate, "relative-trend-crowding-v5");
  assert.equal(v5.summary.baselineComparison.avgReturnDelta, 0);
  assert.equal(v5.summary.baselineComparison.worstReturnDelta, 0);
});

test("pool selector current risk gate v4 filters board switches before non-board fallback", () => {
  const { parseArgs, runPoolSelectorMode } = loadBacktestInternals();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-pool-board-gate-v4-"));
  const chinextDir = path.join(tmp, "chinext");
  const pitSzDir = path.join(tmp, "pitSz");
  const mergedDir = path.join(tmp, "merged");
  const outDir = path.join(tmp, "out");
  const periods = [
    "2026-01-01:2026-01-15",
    "2026-02-01:2026-02-15",
    "2026-03-01:2026-03-15",
  ];

  writeWalkForwardSummary(chinextDir, [
    { periodIndex: 0, period: periods[0], asOf: "2026-01-01", end: "2026-01-15", selectedParam: "c", netAdaptiveWeightedTopReturn: 0.30, netAdaptiveExcessVsBenchmark: 0.25, netAdaptiveWeightedExcessReturn: 0.20 },
    { periodIndex: 1, period: periods[1], asOf: "2026-02-01", end: "2026-02-15", selectedParam: "c", netAdaptiveWeightedTopReturn: 0.18, netAdaptiveExcessVsBenchmark: 0.15, netAdaptiveWeightedExcessReturn: 0.12 },
    { periodIndex: 2, period: periods[2], asOf: "2026-03-01", end: "2026-03-15", selectedParam: "c", netAdaptiveWeightedTopReturn: -0.20, netAdaptiveExcessVsBenchmark: -0.22, netAdaptiveWeightedExcessReturn: -0.18 },
  ]);
  writeWalkForwardSummary(pitSzDir, [
    { periodIndex: 0, period: periods[0], asOf: "2026-01-01", end: "2026-01-15", selectedParam: "p", netAdaptiveWeightedTopReturn: 0.10, netAdaptiveExcessVsBenchmark: 0.08, netAdaptiveWeightedExcessReturn: 0.06 },
    { periodIndex: 1, period: periods[1], asOf: "2026-02-01", end: "2026-02-15", selectedParam: "p", netAdaptiveWeightedTopReturn: 0.12, netAdaptiveExcessVsBenchmark: 0.10, netAdaptiveWeightedExcessReturn: 0.08 },
    { periodIndex: 2, period: periods[2], asOf: "2026-03-01", end: "2026-03-15", selectedParam: "p", netAdaptiveWeightedTopReturn: 0.16, netAdaptiveExcessVsBenchmark: 0.14, netAdaptiveWeightedExcessReturn: 0.12 },
  ]);
  writeWalkForwardSummary(mergedDir, [
    { periodIndex: 0, period: periods[0], asOf: "2026-01-01", end: "2026-01-15", selectedParam: "m", netAdaptiveWeightedTopReturn: 0.04, netAdaptiveExcessVsBenchmark: 0.03, netAdaptiveWeightedExcessReturn: 0.02 },
    { periodIndex: 1, period: periods[1], asOf: "2026-02-01", end: "2026-02-15", selectedParam: "m", netAdaptiveWeightedTopReturn: 0.05, netAdaptiveExcessVsBenchmark: 0.04, netAdaptiveWeightedExcessReturn: 0.03 },
    { periodIndex: 2, period: periods[2], asOf: "2026-03-01", end: "2026-03-15", selectedParam: "m", netAdaptiveWeightedTopReturn: 0.06, netAdaptiveExcessVsBenchmark: 0.05, netAdaptiveWeightedExcessReturn: 0.04 },
  ]);

  writeTop10(chinextDir, periods[1], [
    { code: "c1", name: "C1", r60: 0.50, relativeR60: 0.45, benchmarkR60: 0.02, relativeMomentumScore: 96, relativeR20: 0.22, freshTrendScore: 82, lotterySpikeScore: 68, volumeMomentumScore: 78, volumeTurnoverRatio5v20: 1.6, turnoverStabilityScore: 58, entryDayReturn: 0.02 },
    { code: "c2", name: "C2", r60: 0.52, relativeR60: 0.47, benchmarkR60: 0.02, relativeMomentumScore: 98, relativeR20: 0.24, freshTrendScore: 84, lotterySpikeScore: 70, volumeMomentumScore: 80, volumeTurnoverRatio5v20: 1.6, turnoverStabilityScore: 60, entryDayReturn: 0.02 },
  ]);
  writeTop10(chinextDir, periods[2], [
    { code: "c3", name: "C3", r60: 0.55, relativeR60: 0.48, benchmarkR60: 0.02, relativeMomentumScore: 94, relativeR20: 0.20, freshTrendScore: 67, lotterySpikeScore: 78, volumeMomentumScore: 70, volumeTurnoverRatio5v20: 1.4, turnoverStabilityScore: 50, entryDayReturn: 0.02 },
    { code: "c4", name: "C4", r60: 0.57, relativeR60: 0.50, benchmarkR60: 0.02, relativeMomentumScore: 96, relativeR20: 0.22, freshTrendScore: 69, lotterySpikeScore: 80, volumeMomentumScore: 72, volumeTurnoverRatio5v20: 1.4, turnoverStabilityScore: 52, entryDayReturn: 0.02 },
  ]);
  for (const period of periods) {
    writeTop10(pitSzDir, period, [
      { code: "p1", name: "P1", r60: 0.48, relativeR60: 0.40, benchmarkR60: 0.04, relativeMomentumScore: 84, relativeR20: 0.12, freshTrendScore: 64, lotterySpikeScore: 82, volumeMomentumScore: 64, volumeTurnoverRatio5v20: 1.1, turnoverStabilityScore: 66, entryDayReturn: 0.01 },
      { code: "p2", name: "P2", r60: 0.50, relativeR60: 0.42, benchmarkR60: 0.04, relativeMomentumScore: 86, relativeR20: 0.14, freshTrendScore: 66, lotterySpikeScore: 84, volumeMomentumScore: 66, volumeTurnoverRatio5v20: 1.1, turnoverStabilityScore: 68, entryDayReturn: 0.01 },
    ]);
    writeTop10(mergedDir, period, [
      { code: "m1", name: "M1", r60: 0.42, relativeR60: 0.32, benchmarkR60: 0.04, relativeMomentumScore: 84, relativeR20: 0.10, freshTrendScore: 54, lotterySpikeScore: 82, volumeMomentumScore: 56, volumeTurnoverRatio5v20: 1.0, turnoverStabilityScore: 64, entryDayReturn: 0.01 },
      { code: "m2", name: "M2", r60: 0.44, relativeR60: 0.34, benchmarkR60: 0.04, relativeMomentumScore: 86, relativeR20: 0.12, freshTrendScore: 56, lotterySpikeScore: 84, volumeMomentumScore: 58, volumeTurnoverRatio5v20: 1.0, turnoverStabilityScore: 66, entryDayReturn: 0.01 },
    ]);
  }

  const args = parseArgs([
    "--pool-selector-dirs",
    `chinext=${chinextDir},pitSz=${pitSzDir},merged=${mergedDir}`,
    "--pool-selector-min-train",
    "1",
    "--pool-selector-lookback",
    "1",
    "--pool-selector-known-outcome-only",
    "--pool-selector-baseline",
    "merged",
    "--pool-selector-current-risk-gate",
    "relative-trend-crowding-v4",
    "--out-dir",
    outDir,
  ]);

  runPoolSelectorMode(args);

  const csv = fs.readFileSync(path.join(outDir, "walk_forward_pool_selector_summary.csv"), "utf8");
  assert.match(csv, /selected_by_prior_pool_score/);
  assert.match(csv, /blocked_by_board_confirmation_gate/);

  const summary = JSON.parse(fs.readFileSync(path.join(outDir, "pool_selector_summary.json"), "utf8"));
  assert.equal(summary.options.currentRiskGate, "relative-trend-crowding-v4");
  assert.equal(summary.summary.selectedPoolCounts.chinext, 1);
  assert.equal(summary.summary.selectedPoolCounts.pitSz, 1);
  assert.equal(summary.summary.selectedPoolCounts.merged, undefined);
  assert.equal(summary.summary.avgNetAdaptiveWeightedTopReturn, 0.17);
  assert.equal(summary.baselineComparison.avgReturnDelta, 0.115);
  assert.equal(summary.baselineComparison.worstReturnDelta, 0.1);
});

test("pool selector current risk gate v4 preserves board diagnostics after fallback risk block", () => {
  const { parseArgs, runPoolSelectorMode } = loadBacktestInternals();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-pool-board-risk-chain-v4-"));
  const chinextDir = path.join(tmp, "chinext");
  const pitSzDir = path.join(tmp, "pitSz");
  const mergedDir = path.join(tmp, "merged");
  const outDir = path.join(tmp, "out");
  const periods = [
    "2026-01-01:2026-01-15",
    "2026-02-01:2026-02-15",
  ];

  writeWalkForwardSummary(chinextDir, [
    { periodIndex: 0, period: periods[0], asOf: "2026-01-01", end: "2026-01-15", selectedParam: "c", netAdaptiveWeightedTopReturn: 0.30, netAdaptiveExcessVsBenchmark: 0.25, netAdaptiveWeightedExcessReturn: 0.20 },
    { periodIndex: 1, period: periods[1], asOf: "2026-02-01", end: "2026-02-15", selectedParam: "c", netAdaptiveWeightedTopReturn: -0.10, netAdaptiveExcessVsBenchmark: -0.12, netAdaptiveWeightedExcessReturn: -0.08 },
  ]);
  writeWalkForwardSummary(pitSzDir, [
    { periodIndex: 0, period: periods[0], asOf: "2026-01-01", end: "2026-01-15", selectedParam: "p", netAdaptiveWeightedTopReturn: 0.20, netAdaptiveExcessVsBenchmark: 0.18, netAdaptiveWeightedExcessReturn: 0.16 },
    { periodIndex: 1, period: periods[1], asOf: "2026-02-01", end: "2026-02-15", selectedParam: "p", netAdaptiveWeightedTopReturn: 0.12, netAdaptiveExcessVsBenchmark: 0.10, netAdaptiveWeightedExcessReturn: 0.08 },
  ]);
  writeWalkForwardSummary(mergedDir, [
    { periodIndex: 0, period: periods[0], asOf: "2026-01-01", end: "2026-01-15", selectedParam: "m", netAdaptiveWeightedTopReturn: 0.04, netAdaptiveExcessVsBenchmark: 0.03, netAdaptiveWeightedExcessReturn: 0.02 },
    { periodIndex: 1, period: periods[1], asOf: "2026-02-01", end: "2026-02-15", selectedParam: "m", netAdaptiveWeightedTopReturn: 0.06, netAdaptiveExcessVsBenchmark: 0.05, netAdaptiveWeightedExcessReturn: 0.04 },
  ]);

  writeTop10(chinextDir, periods[1], [
    { code: "c1", name: "C1", r60: 0.40, relativeR60: 0.35, benchmarkR60: 0.02, relativeMomentumScore: 96, relativeR20: 0.20, freshTrendScore: 64, lotterySpikeScore: 78, volumeMomentumScore: 66, volumeTurnoverRatio5v20: 1.3, turnoverStabilityScore: 50, entryDayReturn: 0.02 },
    { code: "c2", name: "C2", r60: 0.42, relativeR60: 0.37, benchmarkR60: 0.02, relativeMomentumScore: 98, relativeR20: 0.22, freshTrendScore: 66, lotterySpikeScore: 80, volumeMomentumScore: 68, volumeTurnoverRatio5v20: 1.3, turnoverStabilityScore: 52, entryDayReturn: 0.02 },
  ]);
  writeTop10(pitSzDir, periods[1], [
    { code: "p1", name: "P1", r60: 0.20, relativeR60: 0.18, benchmarkR60: -0.04, relativeMomentumScore: 76, relativeR20: 0.04, freshTrendScore: 56, lotterySpikeScore: 94, volumeMomentumScore: 58, volumeTurnoverRatio5v20: 1.0, turnoverStabilityScore: 54, entryDayReturn: 0.01 },
    { code: "p2", name: "P2", r60: 0.22, relativeR60: 0.20, benchmarkR60: -0.04, relativeMomentumScore: 78, relativeR20: 0.06, freshTrendScore: 58, lotterySpikeScore: 96, volumeMomentumScore: 60, volumeTurnoverRatio5v20: 1.0, turnoverStabilityScore: 56, entryDayReturn: 0.01 },
  ]);
  writeTop10(mergedDir, periods[1], [
    { code: "m1", name: "M1", r60: 0.42, relativeR60: 0.32, benchmarkR60: 0.04, relativeMomentumScore: 84, relativeR20: 0.10, freshTrendScore: 54, lotterySpikeScore: 82, volumeMomentumScore: 56, volumeTurnoverRatio5v20: 1.0, turnoverStabilityScore: 64, entryDayReturn: 0.01 },
    { code: "m2", name: "M2", r60: 0.44, relativeR60: 0.34, benchmarkR60: 0.04, relativeMomentumScore: 86, relativeR20: 0.12, freshTrendScore: 56, lotterySpikeScore: 84, volumeMomentumScore: 58, volumeTurnoverRatio5v20: 1.0, turnoverStabilityScore: 66, entryDayReturn: 0.01 },
  ]);

  const args = parseArgs([
    "--pool-selector-dirs",
    `chinext=${chinextDir},pitSz=${pitSzDir},merged=${mergedDir}`,
    "--pool-selector-min-train",
    "1",
    "--pool-selector-lookback",
    "1",
    "--pool-selector-known-outcome-only",
    "--pool-selector-baseline",
    "merged",
    "--pool-selector-current-risk-gate",
    "relative-trend-crowding-v4",
    "--out-dir",
    outDir,
  ]);

  runPoolSelectorMode(args);

  const rows = parseCsv(fs.readFileSync(path.join(outDir, "walk_forward_pool_selector_summary.csv"), "utf8"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].selectedPool, "merged");
  assert.equal(rows[0].poolSelectionReason, "blocked_by_current_risk_gate");
  assert.match(rows[0].boardGateReason, /^board_confirmation_failed_/);
  assert.equal(rows[0].boardGateBlockedPool, "chinext");
  assert.equal(rows[0].boardGateFallbackPool, "pitSz");
  assert.equal(rows[0].riskGateBlockedPool, "pitSz");
});

test("result artifacts include walk-forward-selected TopN files distinct from static selected-param TopN", () => {
  const { writeResultArtifacts } = loadBacktestInternals();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-wf-top-artifacts-"));
  const staticResult = {
    asOf: "2026-01-01",
    end: "2026-03-01",
    topN: 10,
    top: [
      { rank: 1, code: "000001", name: "Static", score: 80, recommendedWeight: 1, recommendedWeightPct: 100, forwardReturn: 0.01, netForwardReturn: 0.01 },
    ],
    scored: [
      { rank: 1, code: "000001", name: "Static", score: 80, recommendedWeight: 1, recommendedWeightPct: 100, forwardReturn: 0.01, netForwardReturn: 0.01 },
    ],
    skipped: [],
    topMeanReturn: 0.01,
    netTopMeanReturn: 0.01,
    weightedTopReturn: 0.01,
    netWeightedTopReturn: 0.01,
    adaptiveWeightedTopReturn: 0.01,
    netAdaptiveWeightedTopReturn: 0.01,
    universeMeanReturn: 0,
    netUniverseMeanReturn: 0,
    benchmarkReturn: 0,
    netBenchmarkReturn: 0,
    weightedBenchmarkReturn: 0,
    netWeightedBenchmarkReturn: 0,
    scoredCount: 1,
    skippedCount: 0,
  };
  const walkForwardResult = {
    ...staticResult,
    top: [
      { rank: 1, code: "000002", name: "WalkForward", score: 90, recommendedWeight: 1, recommendedWeightPct: 100, forwardReturn: 0.20, netForwardReturn: 0.20 },
    ],
    scored: [
      { rank: 1, code: "000002", name: "WalkForward", score: 90, recommendedWeight: 1, recommendedWeightPct: 100, forwardReturn: 0.20, netForwardReturn: 0.20 },
    ],
  };

  writeResultArtifacts(tmp, "static_param", [staticResult], [], {
    walkForwardSelectedResults: [walkForwardResult],
  });

  const staticTop = fs.readFileSync(path.join(tmp, "top10_2026-01-01_2026-03-01.csv"), "utf8");
  const wfTop = fs.readFileSync(path.join(tmp, "walk_forward_top10_2026-01-01_2026-03-01.csv"), "utf8");
  assert.match(staticTop, /000001/);
  assert.match(wfTop, /000002/);
});

test("pool selector current feature gate can switch to physical using only TopN asOf features", () => {
  const { parseArgs, runPoolSelectorMode } = loadBacktestInternals();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-pool-feature-gate-"));
  const physicalDir = path.join(tmp, "physical");
  const mergedDir = path.join(tmp, "merged");
  const outDir = path.join(tmp, "out");
  const periods = ["2026-01-01:2026-02-01", "2026-02-01:2026-03-01"];

  writeWalkForwardSummary(physicalDir, [
    { periodIndex: 0, period: periods[0], asOf: "2026-01-01", end: "2026-02-01", selectedParam: "p", netAdaptiveWeightedTopReturn: 0.20, netAdaptiveExcessVsBenchmark: 0.18, netAdaptiveWeightedExcessReturn: 0.12 },
    { periodIndex: 1, period: periods[1], asOf: "2026-02-01", end: "2026-03-01", selectedParam: "p", netAdaptiveWeightedTopReturn: -0.10, netAdaptiveExcessVsBenchmark: -0.12, netAdaptiveWeightedExcessReturn: -0.08 },
  ]);
  writeWalkForwardSummary(mergedDir, [
    { periodIndex: 0, period: periods[0], asOf: "2026-01-01", end: "2026-02-01", selectedParam: "m", netAdaptiveWeightedTopReturn: 0.05, netAdaptiveExcessVsBenchmark: 0.04, netAdaptiveWeightedExcessReturn: 0.02 },
    { periodIndex: 1, period: periods[1], asOf: "2026-02-01", end: "2026-03-01", selectedParam: "m", netAdaptiveWeightedTopReturn: 0.06, netAdaptiveExcessVsBenchmark: 0.05, netAdaptiveWeightedExcessReturn: 0.03 },
  ]);
  writeTop10(physicalDir, periods[0], [
    { code: "p1", name: "P1", relativeMomentumScore: 80, relativeR20: 0.09, volumeMomentumScore: 60, volumeTurnoverRatio5v20: 1.2, entryDayReturn: 0.01 },
    { code: "p2", name: "P2", relativeMomentumScore: 82, relativeR20: 0.07, volumeMomentumScore: 62, volumeTurnoverRatio5v20: 1.1, entryDayReturn: 0.02 },
  ]);
  writeTop10(mergedDir, periods[0], [
    { code: "m1", name: "M1", relativeMomentumScore: 70, relativeR20: 0.03, volumeMomentumScore: 61, volumeTurnoverRatio5v20: 1.0, entryDayReturn: 0.01 },
    { code: "m2", name: "M2", relativeMomentumScore: 72, relativeR20: 0.02, volumeMomentumScore: 60, volumeTurnoverRatio5v20: 1.0, entryDayReturn: 0.01 },
  ]);
  writeTop10(physicalDir, periods[1], [
    { code: "p3", name: "P3", relativeMomentumScore: 73, relativeR20: 0.04, volumeMomentumScore: 60, volumeTurnoverRatio5v20: 1.1, entryDayReturn: 0.01 },
    { code: "p4", name: "P4", relativeMomentumScore: 74, relativeR20: 0.04, volumeMomentumScore: 60, volumeTurnoverRatio5v20: 1.1, entryDayReturn: 0.01 },
  ]);
  writeTop10(mergedDir, periods[1], [
    { code: "m3", name: "M3", relativeMomentumScore: 71, relativeR20: 0.03, volumeMomentumScore: 60, volumeTurnoverRatio5v20: 1.0, entryDayReturn: 0.01 },
    { code: "m4", name: "M4", relativeMomentumScore: 72, relativeR20: 0.03, volumeMomentumScore: 60, volumeTurnoverRatio5v20: 1.0, entryDayReturn: 0.01 },
  ]);

  const args = parseArgs([
    "--pool-selector-dirs",
    `physical=${physicalDir},merged=${mergedDir}`,
    "--pool-selector-current-feature-gate",
    "physical-relative-v1",
    "--pool-selector-baseline",
    "merged",
    "--out-dir",
    outDir,
  ]);

  runPoolSelectorMode(args);

  const csv = fs.readFileSync(path.join(outDir, "walk_forward_pool_selector_summary.csv"), "utf8");
  assert.match(csv, /selected_by_current_feature_gate/);
  assert.match(csv, /kept_feature_baseline_pool/);

  const summary = JSON.parse(fs.readFileSync(path.join(outDir, "pool_selector_summary.json"), "utf8"));
  assert.equal(summary.options.currentFeatureGate, "physical-relative-v1");
  assert.equal(summary.summary.selectedPoolCounts.physical, 1);
  assert.equal(summary.summary.selectedPoolCounts.merged, 1);
  assert.equal(summary.baselineComparison.avgReturnDelta, 0.075);
  assert.equal(summary.baselineComparison.hitCountVsBaseline, 1);
});

test("pool selector feature gate prefers walk-forward TopN artifacts over static selected-param TopN", () => {
  const { parseArgs, runPoolSelectorMode } = loadBacktestInternals();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-pool-feature-wf-top-"));
  const physicalDir = path.join(tmp, "physical");
  const mergedDir = path.join(tmp, "merged");
  const outDir = path.join(tmp, "out");
  const period = "2026-01-01:2026-02-01";

  writeWalkForwardSummary(physicalDir, [
    { periodIndex: 0, period, asOf: "2026-01-01", end: "2026-02-01", selectedParam: "p", netAdaptiveWeightedTopReturn: 0.20, netAdaptiveExcessVsBenchmark: 0.18, netAdaptiveWeightedExcessReturn: 0.12 },
  ]);
  writeWalkForwardSummary(mergedDir, [
    { periodIndex: 0, period, asOf: "2026-01-01", end: "2026-02-01", selectedParam: "m", netAdaptiveWeightedTopReturn: 0.05, netAdaptiveExcessVsBenchmark: 0.04, netAdaptiveWeightedExcessReturn: 0.02 },
  ]);
  writeTop10(physicalDir, period, [
    { code: "oldp1", name: "OldP1", relativeMomentumScore: 60, relativeR20: 0.01, volumeMomentumScore: 50, volumeTurnoverRatio5v20: 1.0, entryDayReturn: 0.01 },
    { code: "oldp2", name: "OldP2", relativeMomentumScore: 61, relativeR20: 0.01, volumeMomentumScore: 50, volumeTurnoverRatio5v20: 1.0, entryDayReturn: 0.01 },
  ]);
  writeTop10(mergedDir, period, [
    { code: "m1", name: "M1", relativeMomentumScore: 70, relativeR20: 0.03, volumeMomentumScore: 60, volumeTurnoverRatio5v20: 1.0, entryDayReturn: 0.01 },
    { code: "m2", name: "M2", relativeMomentumScore: 72, relativeR20: 0.03, volumeMomentumScore: 60, volumeTurnoverRatio5v20: 1.0, entryDayReturn: 0.01 },
  ]);
  writeWalkForwardTop10(physicalDir, period, [
    { code: "wfp1", name: "WfP1", relativeMomentumScore: 82, relativeR20: 0.09, volumeMomentumScore: 65, volumeTurnoverRatio5v20: 1.2, entryDayReturn: 0.01 },
    { code: "wfp2", name: "WfP2", relativeMomentumScore: 84, relativeR20: 0.08, volumeMomentumScore: 66, volumeTurnoverRatio5v20: 1.2, entryDayReturn: 0.01 },
  ]);

  const args = parseArgs([
    "--pool-selector-dirs",
    `physical=${physicalDir},merged=${mergedDir}`,
    "--pool-selector-current-feature-gate",
    "physical-relative-v1",
    "--pool-selector-baseline",
    "merged",
    "--out-dir",
    outDir,
  ]);

  runPoolSelectorMode(args);

  const summary = JSON.parse(fs.readFileSync(path.join(outDir, "pool_selector_summary.json"), "utf8"));
  assert.equal(summary.summary.selectedPoolCounts.physical, 1);
  assert.equal(summary.baselineComparison.avgReturnDelta, 0.15);
});

test("pool selector walk-forward feature gate only trains on completed prior periods", () => {
  const { parseArgs, runPoolSelectorMode } = loadBacktestInternals();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-pool-feature-wf-gate-"));
  const physicalDir = path.join(tmp, "physical");
  const mergedDir = path.join(tmp, "merged");
  const outDir = path.join(tmp, "out");
  const periods = [
    "2026-01-01:2026-03-01",
    "2026-02-01:2026-04-01",
    "2026-03-01:2026-05-01",
    "2026-04-01:2026-06-01",
  ];

  writeWalkForwardSummary(physicalDir, [
    { periodIndex: 0, period: periods[0], asOf: "2026-01-01", end: "2026-03-01", selectedParam: "p", netAdaptiveWeightedTopReturn: 0.20, netAdaptiveExcessVsBenchmark: 0.18, netAdaptiveWeightedExcessReturn: 0.12 },
    { periodIndex: 1, period: periods[1], asOf: "2026-02-01", end: "2026-04-01", selectedParam: "p", netAdaptiveWeightedTopReturn: 0.30, netAdaptiveExcessVsBenchmark: 0.28, netAdaptiveWeightedExcessReturn: 0.20 },
    { periodIndex: 2, period: periods[2], asOf: "2026-03-01", end: "2026-05-01", selectedParam: "p", netAdaptiveWeightedTopReturn: 0.25, netAdaptiveExcessVsBenchmark: 0.22, netAdaptiveWeightedExcessReturn: 0.16 },
    { periodIndex: 3, period: periods[3], asOf: "2026-04-01", end: "2026-06-01", selectedParam: "p", netAdaptiveWeightedTopReturn: -0.10, netAdaptiveExcessVsBenchmark: -0.12, netAdaptiveWeightedExcessReturn: -0.08 },
  ]);
  writeWalkForwardSummary(mergedDir, [
    { periodIndex: 0, period: periods[0], asOf: "2026-01-01", end: "2026-03-01", selectedParam: "m", netAdaptiveWeightedTopReturn: 0.05, netAdaptiveExcessVsBenchmark: 0.04, netAdaptiveWeightedExcessReturn: 0.02 },
    { periodIndex: 1, period: periods[1], asOf: "2026-02-01", end: "2026-04-01", selectedParam: "m", netAdaptiveWeightedTopReturn: 0.06, netAdaptiveExcessVsBenchmark: 0.05, netAdaptiveWeightedExcessReturn: 0.03 },
    { periodIndex: 2, period: periods[2], asOf: "2026-03-01", end: "2026-05-01", selectedParam: "m", netAdaptiveWeightedTopReturn: 0.07, netAdaptiveExcessVsBenchmark: 0.06, netAdaptiveWeightedExcessReturn: 0.04 },
    { periodIndex: 3, period: periods[3], asOf: "2026-04-01", end: "2026-06-01", selectedParam: "m", netAdaptiveWeightedTopReturn: 0.08, netAdaptiveExcessVsBenchmark: 0.07, netAdaptiveWeightedExcessReturn: 0.05 },
  ]);
  for (const [index, period] of periods.entries()) {
    writeTop10(physicalDir, period, [
      { code: "p1", name: "P1", relativeMomentumScore: index === 3 ? 60 : 82, relativeR20: index === 3 ? 0.02 : 0.09, volumeMomentumScore: 65, volumeTurnoverRatio5v20: 1.2, entryDayReturn: 0.01 },
      { code: "p2", name: "P2", relativeMomentumScore: index === 3 ? 61 : 84, relativeR20: index === 3 ? 0.02 : 0.08, volumeMomentumScore: 66, volumeTurnoverRatio5v20: 1.2, entryDayReturn: 0.01 },
    ]);
    writeTop10(mergedDir, period, [
      { code: "m1", name: "M1", relativeMomentumScore: 70, relativeR20: 0.03, volumeMomentumScore: 60, volumeTurnoverRatio5v20: 1.0, entryDayReturn: 0.01 },
      { code: "m2", name: "M2", relativeMomentumScore: 72, relativeR20: 0.03, volumeMomentumScore: 60, volumeTurnoverRatio5v20: 1.0, entryDayReturn: 0.01 },
    ]);
  }

  const args = parseArgs([
    "--pool-selector-dirs",
    `physical=${physicalDir},merged=${mergedDir}`,
    "--pool-selector-current-feature-gate",
    "physical-relative-wf-v1",
    "--pool-selector-min-train",
    "1",
    "--pool-selector-baseline",
    "merged",
    "--out-dir",
    outDir,
  ]);

  runPoolSelectorMode(args);

  const csv = fs.readFileSync(path.join(outDir, "walk_forward_pool_selector_summary.csv"), "utf8");
  assert.match(csv, /warmup_feature_baseline_pool/);
  assert.match(csv, /selected_by_walk_forward_feature_gate/);
  assert.match(csv, /featureGateThresholdName/);

  const summary = JSON.parse(fs.readFileSync(path.join(outDir, "pool_selector_summary.json"), "utf8"));
  assert.equal(summary.options.currentFeatureGate, "physical-relative-wf-v1");
  assert.equal(summary.summary.selectedPoolCounts.physical, 1);
  assert.equal(summary.summary.selectedPoolCounts.merged, 3);
  assert.equal(summary.warmupRowCount, 2);
  assert.equal(summary.trainedSummary.rowCount, 2);
  assert.equal(summary.baselineComparison.avgReturnDelta, 0.045);
  assert.equal(summary.trainedBaselineComparison.avgReturnDelta, 0.09);
});

test("pool selector walk-forward feature gate v2 can learn a relative R60 physical switch", () => {
  const { parseArgs, runPoolSelectorMode } = loadBacktestInternals();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-pool-feature-wf-v2-"));
  const physicalDir = path.join(tmp, "physical");
  const mergedDir = path.join(tmp, "merged");
  const outDir = path.join(tmp, "out");
  const periods = [
    "2026-01-01:2026-01-15",
    "2026-02-01:2026-02-15",
    "2026-03-01:2026-03-15",
    "2026-04-01:2026-04-15",
  ];

  writeWalkForwardSummary(physicalDir, [
    { periodIndex: 0, period: periods[0], asOf: "2026-01-01", end: "2026-01-15", selectedParam: "p", netAdaptiveWeightedTopReturn: 0.16, netAdaptiveExcessVsBenchmark: 0.14, netAdaptiveWeightedExcessReturn: 0.10 },
    { periodIndex: 1, period: periods[1], asOf: "2026-02-01", end: "2026-02-15", selectedParam: "p", netAdaptiveWeightedTopReturn: 0.18, netAdaptiveExcessVsBenchmark: 0.15, netAdaptiveWeightedExcessReturn: 0.11 },
    { periodIndex: 2, period: periods[2], asOf: "2026-03-01", end: "2026-03-15", selectedParam: "p", netAdaptiveWeightedTopReturn: 0.17, netAdaptiveExcessVsBenchmark: 0.15, netAdaptiveWeightedExcessReturn: 0.11 },
    { periodIndex: 3, period: periods[3], asOf: "2026-04-01", end: "2026-04-15", selectedParam: "p", netAdaptiveWeightedTopReturn: 0.20, netAdaptiveExcessVsBenchmark: 0.17, netAdaptiveWeightedExcessReturn: 0.12 },
  ]);
  writeWalkForwardSummary(mergedDir, [
    { periodIndex: 0, period: periods[0], asOf: "2026-01-01", end: "2026-01-15", selectedParam: "m", netAdaptiveWeightedTopReturn: 0.05, netAdaptiveExcessVsBenchmark: 0.04, netAdaptiveWeightedExcessReturn: 0.02 },
    { periodIndex: 1, period: periods[1], asOf: "2026-02-01", end: "2026-02-15", selectedParam: "m", netAdaptiveWeightedTopReturn: 0.06, netAdaptiveExcessVsBenchmark: 0.05, netAdaptiveWeightedExcessReturn: 0.03 },
    { periodIndex: 2, period: periods[2], asOf: "2026-03-01", end: "2026-03-15", selectedParam: "m", netAdaptiveWeightedTopReturn: 0.07, netAdaptiveExcessVsBenchmark: 0.06, netAdaptiveWeightedExcessReturn: 0.04 },
    { periodIndex: 3, period: periods[3], asOf: "2026-04-01", end: "2026-04-15", selectedParam: "m", netAdaptiveWeightedTopReturn: 0.08, netAdaptiveExcessVsBenchmark: 0.07, netAdaptiveWeightedExcessReturn: 0.05 },
  ]);
  for (const period of periods) {
    writeTop10(physicalDir, period, [
      { code: "p1", name: "P1", relativeMomentumScore: 70, relativeR20: 0.03, r60: 0.20, benchmarkR20: 0.04, volumeMomentumScore: 55, volumeTurnoverRatio5v20: 1.0, turnoverStabilityScore: 70, entryDayReturn: 0.01 },
      { code: "p2", name: "P2", relativeMomentumScore: 71, relativeR20: 0.03, r60: 0.22, benchmarkR20: 0.04, volumeMomentumScore: 56, volumeTurnoverRatio5v20: 1.0, turnoverStabilityScore: 72, entryDayReturn: 0.01 },
    ]);
    writeTop10(mergedDir, period, [
      { code: "m1", name: "M1", relativeMomentumScore: 72, relativeR20: 0.03, r60: 0.06, benchmarkR20: 0.03, volumeMomentumScore: 58, volumeTurnoverRatio5v20: 1.0, turnoverStabilityScore: 70, entryDayReturn: 0.01 },
      { code: "m2", name: "M2", relativeMomentumScore: 73, relativeR20: 0.03, r60: 0.07, benchmarkR20: 0.03, volumeMomentumScore: 59, volumeTurnoverRatio5v20: 1.0, turnoverStabilityScore: 70, entryDayReturn: 0.01 },
    ]);
  }

  const args = parseArgs([
    "--pool-selector-dirs",
    `physical=${physicalDir},merged=${mergedDir}`,
    "--pool-selector-current-feature-gate",
    "physical-relative-wf-v2",
    "--pool-selector-min-train",
    "1",
    "--pool-selector-baseline",
    "merged",
    "--out-dir",
    outDir,
  ]);

  runPoolSelectorMode(args);

  const csv = fs.readFileSync(path.join(outDir, "walk_forward_pool_selector_summary.csv"), "utf8");
  assert.match(csv, /featureGateRelativeR60Advantage/);
  assert.match(csv, /selected_by_walk_forward_feature_gate/);

  const summary = JSON.parse(fs.readFileSync(path.join(outDir, "pool_selector_summary.json"), "utf8"));
  assert.equal(summary.options.currentFeatureGate, "physical-relative-wf-v2");
  assert.equal(summary.summary.selectedPoolCounts.physical, 3);
  assert.equal(summary.summary.selectedPoolCounts.merged, 1);
  assert.equal(summary.trainedBaselineComparison.avgReturnDelta, 0.113333);
});

test("pool selector walk-forward feature gate v3 blocks benchmark-only switch with weak relative R60", () => {
  const { parseArgs, runPoolSelectorMode } = loadBacktestInternals();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-pool-feature-wf-v3-"));
  const physicalDir = path.join(tmp, "physical");
  const mergedDir = path.join(tmp, "merged");
  const outDir = path.join(tmp, "out");
  const periods = [
    "2026-01-01:2026-01-15",
    "2026-02-01:2026-02-15",
    "2026-03-01:2026-03-15",
    "2026-04-01:2026-04-15",
  ];

  writeWalkForwardSummary(physicalDir, [
    { periodIndex: 0, period: periods[0], asOf: "2026-01-01", end: "2026-01-15", selectedParam: "p", netAdaptiveWeightedTopReturn: 0.20, netAdaptiveExcessVsBenchmark: 0.18, netAdaptiveWeightedExcessReturn: 0.12 },
    { periodIndex: 1, period: periods[1], asOf: "2026-02-01", end: "2026-02-15", selectedParam: "p", netAdaptiveWeightedTopReturn: 0.18, netAdaptiveExcessVsBenchmark: 0.16, netAdaptiveWeightedExcessReturn: 0.11 },
    { periodIndex: 2, period: periods[2], asOf: "2026-03-01", end: "2026-03-15", selectedParam: "p", netAdaptiveWeightedTopReturn: 0.16, netAdaptiveExcessVsBenchmark: 0.14, netAdaptiveWeightedExcessReturn: 0.10 },
    { periodIndex: 3, period: periods[3], asOf: "2026-04-01", end: "2026-04-15", selectedParam: "p", netAdaptiveWeightedTopReturn: 0.02, netAdaptiveExcessVsBenchmark: 0.01, netAdaptiveWeightedExcessReturn: 0.00 },
  ]);
  writeWalkForwardSummary(mergedDir, [
    { periodIndex: 0, period: periods[0], asOf: "2026-01-01", end: "2026-01-15", selectedParam: "m", netAdaptiveWeightedTopReturn: 0.05, netAdaptiveExcessVsBenchmark: 0.04, netAdaptiveWeightedExcessReturn: 0.02 },
    { periodIndex: 1, period: periods[1], asOf: "2026-02-01", end: "2026-02-15", selectedParam: "m", netAdaptiveWeightedTopReturn: 0.06, netAdaptiveExcessVsBenchmark: 0.05, netAdaptiveWeightedExcessReturn: 0.03 },
    { periodIndex: 2, period: periods[2], asOf: "2026-03-01", end: "2026-03-15", selectedParam: "m", netAdaptiveWeightedTopReturn: 0.07, netAdaptiveExcessVsBenchmark: 0.06, netAdaptiveWeightedExcessReturn: 0.04 },
    { periodIndex: 3, period: periods[3], asOf: "2026-04-01", end: "2026-04-15", selectedParam: "m", netAdaptiveWeightedTopReturn: 0.08, netAdaptiveExcessVsBenchmark: 0.07, netAdaptiveWeightedExcessReturn: 0.05 },
  ]);
  for (const [index, period] of periods.entries()) {
    const weakRelativeR60 = index === 3;
    writeTop10(physicalDir, period, [
      { code: "p1", name: "P1", relativeMomentumScore: 60, relativeR20: 0.01, r60: weakRelativeR60 ? 0.00 : 0.20, benchmarkR20: 0.05, volumeMomentumScore: 50, volumeTurnoverRatio5v20: 1.0, turnoverStabilityScore: 70, entryDayReturn: 0.01 },
      { code: "p2", name: "P2", relativeMomentumScore: 61, relativeR20: 0.01, r60: weakRelativeR60 ? 0.00 : 0.22, benchmarkR20: 0.05, volumeMomentumScore: 51, volumeTurnoverRatio5v20: 1.0, turnoverStabilityScore: 72, entryDayReturn: 0.01 },
    ]);
    writeTop10(mergedDir, period, [
      { code: "m1", name: "M1", relativeMomentumScore: 70, relativeR20: 0.03, r60: 0.10, benchmarkR20: 0.03, volumeMomentumScore: 60, volumeTurnoverRatio5v20: 1.0, turnoverStabilityScore: 70, entryDayReturn: 0.01 },
      { code: "m2", name: "M2", relativeMomentumScore: 71, relativeR20: 0.03, r60: 0.12, benchmarkR20: 0.03, volumeMomentumScore: 61, volumeTurnoverRatio5v20: 1.0, turnoverStabilityScore: 70, entryDayReturn: 0.01 },
    ]);
  }

  const args = parseArgs([
    "--pool-selector-dirs",
    `physical=${physicalDir},merged=${mergedDir}`,
    "--pool-selector-current-feature-gate",
    "physical-relative-wf-v3",
    "--pool-selector-min-train",
    "1",
    "--pool-selector-baseline",
    "merged",
    "--out-dir",
    outDir,
  ]);

  runPoolSelectorMode(args);

  const csv = fs.readFileSync(path.join(outDir, "walk_forward_pool_selector_summary.csv"), "utf8");
  assert.match(csv, /kept_walk_forward_feature_baseline_pool/);
  assert.match(csv, /featureGateR60Threshold/);

  const summary = JSON.parse(fs.readFileSync(path.join(outDir, "pool_selector_summary.json"), "utf8"));
  assert.equal(summary.options.currentFeatureGate, "physical-relative-wf-v3");
  assert.equal(summary.summary.selectedPoolCounts.physical, 2);
  assert.equal(summary.summary.selectedPoolCounts.merged, 2);
  assert.equal(summary.trainedBaselineComparison.avgReturnDelta, 0.07);
  assert.equal(summary.trainedBaselineComparison.worstReturnDelta, 0);
});
