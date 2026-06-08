const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildPlan,
  parseArgs,
} = require("./alpha_multi_universe_backtest");

test("multi-universe runner plans one backtest per universe and one pool selector", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-multi-universe-"));
  const physicalCsv = path.join(tmp, "physical.csv");
  const mergedCsv = path.join(tmp, "merged.csv");
  fs.writeFileSync(physicalCsv, "code,name\n000001,A\n");
  fs.writeFileSync(mergedCsv, "code,name\n000002,B\n");

  const args = parseArgs([
    "--universe-runs",
    `physical=${physicalCsv},merged=${mergedCsv}`,
    "--out-root",
    path.join(tmp, "out"),
    "--pool-selector-lookback",
    "6",
    "--pool-selector-min-train",
    "6",
    "--pool-selector-initial",
    "merged",
    "--pool-selector-include-warmup",
    "--",
    "--periods",
    "2026-01-01:2026-03-01,2026-02-01:2026-04-01",
    "--top",
    "10",
    "--cache-only",
  ]);
  const plan = buildPlan(args, { now: "20260607-200000" });

  assert.equal(plan.poolRuns.length, 2);
  assert.equal(plan.backtestSteps.length, 2);
  assert.equal(plan.backtestSteps[0].name, "physical");
  assert.match(plan.backtestSteps[0].args.join(" "), /--universe .*physical\.csv/);
  assert.match(plan.backtestSteps[0].args.join(" "), /--out-dir .*physical/);
  assert.ok(plan.backtestSteps[0].args.includes("--cache-only"));
  assert.equal(plan.poolSelectorStep.outDir, path.join(tmp, "out", "pool-selector"));
  assert.equal(
    plan.poolSelectorStep.poolSelectorDirs,
    [
      `physical=${path.join(tmp, "out", "physical")}`,
      `merged=${path.join(tmp, "out", "merged")}`,
    ].join(",")
  );
  assert.ok(plan.poolSelectorStep.args.includes("--pool-selector-include-warmup"));
});

test("multi-universe runner can reuse completed run dirs instead of planning reruns", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-multi-universe-reuse-"));
  const physicalDir = path.join(tmp, "physical-done");
  const mergedDir = path.join(tmp, "merged-done");
  fs.mkdirSync(physicalDir, { recursive: true });
  fs.mkdirSync(mergedDir, { recursive: true });
  fs.writeFileSync(path.join(physicalDir, "walk_forward_summary.csv"), "period,netAdaptiveWeightedTopReturn\np,0.1\n");
  fs.writeFileSync(path.join(mergedDir, "walk_forward_summary.csv"), "period,netAdaptiveWeightedTopReturn\np,0.2\n");

  const args = parseArgs([
    "--completed-run-dirs",
    `physical=${physicalDir},merged=${mergedDir}`,
    "--out-root",
    path.join(tmp, "out"),
    "--reuse-existing",
    "--pool-selector-initial",
    "physical",
  ]);
  const plan = buildPlan(args, { now: "20260607-200000" });

  assert.equal(plan.backtestSteps.length, 0);
  assert.equal(plan.reusedSteps.length, 2);
  assert.equal(
    plan.poolSelectorStep.poolSelectorDirs,
    [`physical=${physicalDir}`, `merged=${mergedDir}`].join(",")
  );
});

test("multi-universe runner accepts repeated universe-run values with comma-merged csvs", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-multi-universe-comma-"));
  const physicalCsv = path.join(tmp, "physical.csv");
  const themeCsv = path.join(tmp, "theme.csv");
  const hkCsv = path.join(tmp, "hk.csv");
  const args = parseArgs([
    "--universe-run",
    `physical=${physicalCsv}`,
    "--universe-run",
    `merged=${physicalCsv},${themeCsv},${hkCsv}`,
    "--out-root",
    path.join(tmp, "out"),
    "--",
    "--cache-only",
  ]);
  const plan = buildPlan(args, { now: "20260607-200000" });

  assert.equal(plan.backtestSteps.length, 2);
  assert.equal(plan.backtestSteps[1].name, "merged");
  assert.equal(plan.backtestSteps[1].universe, `${physicalCsv},${themeCsv},${hkCsv}`);
  assert.equal(plan.backtestSteps[1].args[2], `${physicalCsv},${themeCsv},${hkCsv}`);
});
