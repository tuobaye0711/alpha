#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const SCRIPT_DIR = __dirname;
const ALPHA_BACKTEST = path.join(SCRIPT_DIR, "alpha_backtest.js");
const DEFAULT_OUTPUT_ROOT = path.resolve(SCRIPT_DIR, "..", "output");

function usage() {
  return [
    "Usage: node alpha_multi_universe_backtest.js [options] -- [alpha_backtest options]",
    "",
    "Options:",
    "  --universe-runs <name=csv,...>        多个股票池 CSV；每个池会运行一次 alpha_backtest",
    "  --universe-run <name=csv[,csv2]>      单个股票池；可重复使用，value 内允许 alpha_backtest 的逗号合并 CSV",
    "  --completed-run-dirs <name=dir,...>   复用已完成回测目录；目录内必须有 walk_forward_summary.csv",
    "  --completed-run-dir <name=dir>        单个已完成目录；可重复使用",
    "  --out-root <dir>                      本轮多池输出根目录",
    "  --reuse-existing                      如果 out-root/name 已有 walk_forward_summary.csv，则跳过该池重跑",
    "  --dry-run                             只写 multi_universe_plan.json，不执行命令",
    "  --pool-selector-lookback <n>          池级选择训练回看窗口，默认 6",
    "  --pool-selector-min-train <n>         池级选择开始训练窗口数，默认 6",
    "  --pool-selector-initial <name>        warmup 期默认股票池，默认第一个 pool",
    "  --pool-selector-score-excess-weight <n> 池级净超大盘权重，默认 0.35",
    "  --pool-selector-include-warmup        输出 warmup 期 initial pool 结果",
    "  --help",
  ].join("\n");
}

function safeName(value) {
  return String(value || "pool").replace(/[^A-Za-z0-9_.-]+/g, "_");
}

function timestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function parseNamePathPair(value, optionName) {
  const text = String(value || "").trim();
  const separator = text.indexOf("=");
  if (separator <= 0 || separator === text.length - 1) {
    throw new Error(`${optionName} entry must be name=path`);
  }
  const name = text.slice(0, separator).trim();
  const filePath = path.resolve(text.slice(separator + 1).trim());
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid ${optionName} name: ${name}`);
  }
  return { name, path: filePath };
}

function parseNamePathPairs(value, optionName) {
  const seen = new Set();
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const separator = item.indexOf("=");
      if (separator <= 0 || separator === item.length - 1) {
        throw new Error(`${optionName} entries must be name=path`);
      }
      const name = item.slice(0, separator).trim();
      const filePath = path.resolve(item.slice(separator + 1).trim());
      if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        throw new Error(`Invalid ${optionName} name: ${name}`);
      }
      if (seen.has(name)) {
        throw new Error(`Duplicate ${optionName} name: ${name}`);
      }
      seen.add(name);
      return { name, path: filePath };
    });
}

function parseArgs(argv) {
  const args = {
    universeRuns: [],
    completedRunDirs: [],
    outRoot: "",
    reuseExisting: false,
    dryRun: false,
    poolSelectorLookback: 6,
    poolSelectorMinTrain: 6,
    poolSelectorInitialPool: "",
    poolSelectorScoreExcessWeight: 0.35,
    poolSelectorIncludeWarmup: false,
    backtestArgs: [],
  };
  const separatorIndex = argv.indexOf("--");
  const ownArgs = separatorIndex >= 0 ? argv.slice(0, separatorIndex) : argv.slice();
  args.backtestArgs = separatorIndex >= 0 ? argv.slice(separatorIndex + 1) : [];

  for (let i = 0; i < ownArgs.length; i += 1) {
    const arg = ownArgs[i];
    const next = () => {
      if (i + 1 >= ownArgs.length) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return ownArgs[i];
    };
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--universe-run") {
      const item = parseNamePathPair(next(), "--universe-run");
      args.universeRuns.push({ name: item.name, universe: item.path });
    } else if (arg === "--universe-runs") {
      args.universeRuns = parseNamePathPairs(next(), "--universe-runs").map((item) => ({
        name: item.name,
        universe: item.path,
      }));
    } else if (arg === "--completed-run-dir") {
      const item = parseNamePathPair(next(), "--completed-run-dir");
      args.completedRunDirs.push({ name: item.name, dir: item.path });
    } else if (arg === "--completed-run-dirs") {
      args.completedRunDirs = parseNamePathPairs(next(), "--completed-run-dirs").map((item) => ({
        name: item.name,
        dir: item.path,
      }));
    } else if (arg === "--out-root") {
      args.outRoot = path.resolve(next());
    } else if (arg === "--reuse-existing") {
      args.reuseExisting = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--pool-selector-lookback") {
      args.poolSelectorLookback = Number(next());
    } else if (arg === "--pool-selector-min-train") {
      args.poolSelectorMinTrain = Number(next());
    } else if (arg === "--pool-selector-initial") {
      args.poolSelectorInitialPool = next();
    } else if (arg === "--pool-selector-score-excess-weight") {
      args.poolSelectorScoreExcessWeight = Number(next());
    } else if (arg === "--pool-selector-include-warmup") {
      args.poolSelectorIncludeWarmup = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  const poolNames = new Set();
  for (const run of args.universeRuns) {
    if (poolNames.has(run.name)) throw new Error(`Duplicate pool name: ${run.name}`);
    poolNames.add(run.name);
  }
  for (const run of args.completedRunDirs) {
    if (poolNames.has(run.name)) throw new Error(`Duplicate pool name: ${run.name}`);
    poolNames.add(run.name);
  }
  if (!poolNames.size && !args.help) {
    throw new Error("At least one --universe-runs or --completed-run-dirs entry is required");
  }
  if (!Number.isInteger(args.poolSelectorLookback) || args.poolSelectorLookback <= 0) {
    throw new Error("Invalid --pool-selector-lookback");
  }
  if (!Number.isInteger(args.poolSelectorMinTrain) || args.poolSelectorMinTrain <= 0) {
    throw new Error("Invalid --pool-selector-min-train");
  }
  if (!Number.isFinite(args.poolSelectorScoreExcessWeight)) {
    throw new Error("Invalid --pool-selector-score-excess-weight");
  }
  if (args.poolSelectorInitialPool && !poolNames.has(args.poolSelectorInitialPool)) {
    throw new Error(`Unknown --pool-selector-initial: ${args.poolSelectorInitialPool}`);
  }
  return args;
}

function walkForwardSummaryFile(dir) {
  return path.join(dir, "walk_forward_summary.csv");
}

function buildPlan(args, deps = {}) {
  const now = deps.now || timestamp();
  const outRoot = args.outRoot || path.join(DEFAULT_OUTPUT_ROOT, `multi-universe-${now}`);
  const completed = new Map(args.completedRunDirs.map((run) => [run.name, run.dir]));
  const poolRuns = [];
  const backtestSteps = [];
  const reusedSteps = [];

  for (const run of args.completedRunDirs) {
    poolRuns.push({
      name: run.name,
      outDir: run.dir,
      source: "completed",
    });
    reusedSteps.push({
      name: run.name,
      outDir: run.dir,
      reason: "completed-run-dir",
    });
  }

  for (const run of args.universeRuns) {
    if (completed.has(run.name)) continue;
    const outDir = path.join(outRoot, safeName(run.name));
    poolRuns.push({
      name: run.name,
      universe: run.universe,
      outDir,
      source: "universe",
    });
    if (args.reuseExisting && fs.existsSync(walkForwardSummaryFile(outDir))) {
      reusedSteps.push({
        name: run.name,
        outDir,
        reason: "existing-walk-forward-summary",
      });
      continue;
    }
    backtestSteps.push({
      name: run.name,
      command: process.execPath,
      args: [
        ALPHA_BACKTEST,
        "--universe",
        run.universe,
        "--out-dir",
        outDir,
        ...args.backtestArgs,
      ],
      outDir,
      universe: run.universe,
    });
  }

  const initialPool = args.poolSelectorInitialPool || poolRuns[0]?.name || "";
  const poolSelectorDirs = poolRuns.map((run) => `${run.name}=${run.outDir}`).join(",");
  const poolSelectorOutDir = path.join(outRoot, "pool-selector");
  const poolSelectorArgs = [
    ALPHA_BACKTEST,
    "--pool-selector-dirs",
    poolSelectorDirs,
    "--pool-selector-lookback",
    String(args.poolSelectorLookback),
    "--pool-selector-min-train",
    String(args.poolSelectorMinTrain),
    "--pool-selector-initial",
    initialPool,
    "--pool-selector-score-excess-weight",
    String(args.poolSelectorScoreExcessWeight),
    "--out-dir",
    poolSelectorOutDir,
  ];
  if (args.poolSelectorIncludeWarmup) {
    poolSelectorArgs.splice(poolSelectorArgs.length - 2, 0, "--pool-selector-include-warmup");
  }

  return {
    generatedAt: new Date().toISOString(),
    outRoot,
    poolRuns,
    backtestSteps,
    reusedSteps,
    poolSelectorStep: {
      command: process.execPath,
      args: poolSelectorArgs,
      outDir: poolSelectorOutDir,
      poolSelectorDirs,
      initialPool,
    },
    dryRun: args.dryRun,
    reuseExisting: args.reuseExisting,
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function runCommand(step) {
  console.log(`[alpha-multi-universe] run ${step.name || "pool-selector"}: ${step.command} ${step.args.join(" ")}`);
  const result = spawnSync(step.command, step.args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Command failed for ${step.name || "pool-selector"} with exit ${result.status}`);
  }
}

function validateReusableStep(step) {
  if (!fs.existsSync(walkForwardSummaryFile(step.outDir))) {
    throw new Error(`Missing walk_forward_summary.csv for reused pool ${step.name}: ${step.outDir}`);
  }
}

function runPlan(plan) {
  ensureDir(plan.outRoot);
  fs.writeFileSync(path.join(plan.outRoot, "multi_universe_plan.json"), JSON.stringify(plan, null, 2));
  if (plan.dryRun) {
    console.log(`[alpha-multi-universe] dry-run plan=${path.join(plan.outRoot, "multi_universe_plan.json")}`);
    return;
  }
  for (const step of plan.reusedSteps) validateReusableStep(step);
  for (const step of plan.backtestSteps) {
    runCommand(step);
    validateReusableStep(step);
  }
  runCommand({ ...plan.poolSelectorStep, name: "pool-selector" });
  const summaryFile = path.join(plan.poolSelectorStep.outDir, "pool_selector_summary.json");
  if (!fs.existsSync(summaryFile)) {
    throw new Error(`Missing pool selector summary: ${summaryFile}`);
  }
  console.log(`[alpha-multi-universe] summary=${summaryFile}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const plan = buildPlan(args);
  runPlan(plan);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[alpha-multi-universe] ERROR ${error.stack || error.message}`);
    process.exit(1);
  }
}

module.exports = {
  buildPlan,
  parseArgs,
  runPlan,
  usage,
};
