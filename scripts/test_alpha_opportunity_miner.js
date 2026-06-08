const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { parseCsv } = require("./lib/backtest_engine");
const {
  compareCandidate,
  parseArgs,
  run,
} = require("./alpha_opportunity_miner");

function writeCsv(file, rows, headers = Object.keys(rows[0] || {})) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [headers.join(","), ...rows.map((row) => headers.map((header) => row[header] ?? "").join(","))].join("\n")
  );
}

function writeRun(dir, rows, scoredHeaders = ["rank", "code", "score"]) {
  writeCsv(path.join(dir, "walk_forward_summary.csv"), rows, [
    "period",
    "selectedParam",
    "netAdaptiveWeightedTopReturn",
    "netAdaptiveExcessVsBenchmark",
    "netAdaptiveWeightedExcessReturn",
  ]);
  const [asOf, end] = rows[0].period.split(":");
  fs.writeFileSync(path.join(dir, `scored_${asOf}_${end}.csv`), `${scoredHeaders.join(",")}\n1,000001,88\n`);
}

test("opportunity miner compares a candidate with baseline across matched periods", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-opportunity-"));
  const baseline = path.join(tmp, "baseline");
  const candidate = path.join(tmp, "candidate");
  writeRun(baseline, [
    { period: "2026-01-01:2026-03-01", selectedParam: "base", netAdaptiveWeightedTopReturn: "0.10", netAdaptiveExcessVsBenchmark: "0.04", netAdaptiveWeightedExcessReturn: "0.03" },
    { period: "2026-02-01:2026-04-01", selectedParam: "base", netAdaptiveWeightedTopReturn: "0.02", netAdaptiveExcessVsBenchmark: "-0.01", netAdaptiveWeightedExcessReturn: "0.01" },
  ]);
  writeRun(candidate, [
    { period: "2026-01-01:2026-03-01", selectedParam: "candidate", netAdaptiveWeightedTopReturn: "0.13", netAdaptiveExcessVsBenchmark: "0.05", netAdaptiveWeightedExcessReturn: "0.04" },
    { period: "2026-02-01:2026-04-01", selectedParam: "candidate", netAdaptiveWeightedTopReturn: "-0.01", netAdaptiveExcessVsBenchmark: "-0.03", netAdaptiveWeightedExcessReturn: "-0.02" },
  ]);

  const result = compareCandidate({
    baselineDir: baseline,
    candidateName: "testCandidate",
    candidateDir: candidate,
  });

  assert.equal(result.summary.commonPeriodCount, 2);
  assert.equal(result.summary.avgNetAdaptiveDelta, 0);
  assert.equal(result.summary.improveWindowCount, 1);
  assert.equal(result.summary.harmWindowCount, 1);
  assert.equal(result.summary.scoredHeaderCompatible, true);
  assert.equal(result.periods[0].netAdaptiveDelta, 0.03);
  assert.equal(result.periods[1].netAdaptiveDelta, -0.03);
});

test("opportunity miner writes summary, period details and flags stale scored schemas", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-opportunity-run-"));
  const baseline = path.join(tmp, "baseline");
  const candidate = path.join(tmp, "candidate");
  const outDir = path.join(tmp, "out");
  writeRun(baseline, [
    { period: "2026-01-01:2026-03-01", selectedParam: "base", netAdaptiveWeightedTopReturn: "0.05", netAdaptiveExcessVsBenchmark: "0.01", netAdaptiveWeightedExcessReturn: "0.02" },
  ], ["rank", "code", "score", "lotterySpikeScore"]);
  writeRun(candidate, [
    { period: "2026-01-01:2026-03-01", selectedParam: "candidate", netAdaptiveWeightedTopReturn: "0.09", netAdaptiveExcessVsBenchmark: "0.04", netAdaptiveWeightedExcessReturn: "0.03" },
  ], ["rank", "code", "score"]);

  run(parseArgs([
    "--baseline-dir",
    baseline,
    "--candidate-dir",
    `candidate=${candidate}`,
    "--out-dir",
    outDir,
  ]));

  const summary = parseCsv(fs.readFileSync(path.join(outDir, "opportunity_summary.csv"), "utf8"));
  const periods = parseCsv(fs.readFileSync(path.join(outDir, "period_opportunities.csv"), "utf8"));
  const json = JSON.parse(fs.readFileSync(path.join(outDir, "opportunity_summary.json"), "utf8"));
  assert.equal(summary[0].candidateName, "candidate");
  assert.equal(summary[0].scoredHeaderCompatible, "false");
  assert.equal(periods[0].period, "2026-01-01:2026-03-01");
  assert.ok(Math.abs(json.candidates[0].summary.avgNetAdaptiveDelta - 0.04) < 1e-9);
});
