#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const { mean, parseCsv, writeCsv } = require("./lib/backtest_engine");

function usage() {
  return [
    "Usage: node alpha_opportunity_miner.js --baseline-dir <dir> --candidate-dir <name=dir> [--candidate-dir <name=dir>] --out-dir <dir>",
    "",
    "Options:",
    "  --baseline-dir <dir>       Baseline backtest directory",
    "  --candidate-dir <name=dir>  Candidate backtest directory; repeatable",
    "  --candidate-dirs <a=dir,b=dir> Candidate directories; comma-separated",
    "  --out-dir <dir>            Output directory",
    "  --min-delta <n>            Window improve/harm threshold, default 0.000001",
    "  --help",
  ].join("\n");
}

function parseNameDir(value, optionName) {
  const text = String(value || "").trim();
  const separator = text.indexOf("=");
  if (separator <= 0 || separator === text.length - 1) {
    throw new Error(`${optionName} entry must be name=dir`);
  }
  const name = text.slice(0, separator).trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error(`Invalid ${optionName} name: ${name}`);
  return {
    name,
    dir: path.resolve(text.slice(separator + 1).trim()),
  };
}

function parseNameDirs(value, optionName) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => parseNameDir(item, optionName));
}

function parseArgs(argv) {
  const args = {
    baselineDir: "",
    candidateDirs: [],
    outDir: "",
    minDelta: 0.000001,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return argv[i];
    };
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--baseline-dir") {
      args.baselineDir = path.resolve(next());
    } else if (arg === "--candidate-dir") {
      const item = parseNameDir(next(), "--candidate-dir");
      args.candidateDirs.push({ name: item.name, dir: item.dir });
    } else if (arg === "--candidate-dirs") {
      args.candidateDirs.push(...parseNameDirs(next(), "--candidate-dirs"));
    } else if (arg === "--out-dir") {
      args.outDir = path.resolve(next());
    } else if (arg === "--min-delta") {
      args.minDelta = Number(next());
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!args.help && !args.baselineDir) throw new Error("Missing --baseline-dir");
  if (!args.help && !args.candidateDirs.length) throw new Error("Missing --candidate-dir");
  if (!args.help && !args.outDir) throw new Error("Missing --out-dir");
  if (!Number.isFinite(args.minDelta) || args.minDelta < 0) throw new Error("Invalid --min-delta");
  const seen = new Set();
  for (const candidate of args.candidateDirs) {
    if (seen.has(candidate.name)) throw new Error(`Duplicate candidate name: ${candidate.name}`);
    seen.add(candidate.name);
  }
  return args;
}

function summaryFile(dir) {
  const walkForward = path.join(dir, "walk_forward_summary.csv");
  if (fs.existsSync(walkForward)) return walkForward;
  const periodSummary = path.join(dir, "period_summary.csv");
  if (fs.existsSync(periodSummary)) return periodSummary;
  throw new Error(`No walk_forward_summary.csv or period_summary.csv in ${dir}`);
}

function readSummaryRows(dir) {
  const file = summaryFile(dir);
  return parseCsv(fs.readFileSync(file, "utf8")).map((row, index) => ({
    ...row,
    period: row.period || `${row.asOf || ""}:${row.end || ""}`,
    periodIndex: row.periodIndex || String(index),
  }));
}

function rowsByPeriod(rows) {
  const result = new Map();
  for (const row of rows) {
    if (row.period) result.set(row.period, row);
  }
  return result;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function delta(candidate, baseline, field) {
  const a = num(candidate?.[field]);
  const b = num(baseline?.[field]);
  return Number.isFinite(a) && Number.isFinite(b) ? a - b : null;
}

function firstScoredFile(dir) {
  if (!fs.existsSync(dir)) return "";
  return fs.readdirSync(dir)
    .filter((file) => /^scored_.*\.csv$/.test(file))
    .sort()[0] || "";
}

function csvHeader(file) {
  if (!file || !fs.existsSync(file)) return "";
  const text = fs.readFileSync(file, "utf8");
  return text.split(/\r?\n/, 1)[0] || "";
}

function scoredHeaderAudit(baselineDir, candidateDir) {
  const baselineFile = firstScoredFile(baselineDir);
  const candidateFile = firstScoredFile(candidateDir);
  const baselineHeader = csvHeader(path.join(baselineDir, baselineFile));
  const candidateHeader = csvHeader(path.join(candidateDir, candidateFile));
  return {
    baselineScoredFile: baselineFile,
    candidateScoredFile: candidateFile,
    baselineScoredHeaderCount: baselineHeader ? baselineHeader.split(",").length : 0,
    candidateScoredHeaderCount: candidateHeader ? candidateHeader.split(",").length : 0,
    scoredHeaderCompatible: Boolean(baselineHeader && candidateHeader && baselineHeader === candidateHeader),
  };
}

function compareCandidate(options) {
  const baselineRows = readSummaryRows(options.baselineDir);
  const candidateRows = readSummaryRows(options.candidateDir);
  const baselineMap = rowsByPeriod(baselineRows);
  const candidateMap = rowsByPeriod(candidateRows);
  const minDelta = Number.isFinite(options.minDelta) ? options.minDelta : 0.000001;
  const periodRows = [];
  for (const period of baselineMap.keys()) {
    if (!candidateMap.has(period)) continue;
    const baseline = baselineMap.get(period);
    const candidate = candidateMap.get(period);
    const netAdaptiveDelta = delta(candidate, baseline, "netAdaptiveWeightedTopReturn");
    const netBenchmarkExcessDelta = delta(candidate, baseline, "netAdaptiveExcessVsBenchmark");
    const netUniverseExcessDelta = delta(candidate, baseline, "netAdaptiveWeightedExcessReturn");
    periodRows.push({
      candidateName: options.candidateName,
      period,
      baselineSelectedParam: baseline.selectedParam || baseline.param || "",
      candidateSelectedParam: candidate.selectedParam || candidate.param || "",
      baselineNetAdaptiveWeightedTopReturn: num(baseline.netAdaptiveWeightedTopReturn),
      candidateNetAdaptiveWeightedTopReturn: num(candidate.netAdaptiveWeightedTopReturn),
      netAdaptiveDelta,
      netBenchmarkExcessDelta,
      netUniverseExcessDelta,
      baselineSelectionReason: baseline.selectionReason || "",
      candidateSelectionReason: candidate.selectionReason || "",
      baselineCurrentGateReason: baseline.currentGateReason || "",
      candidateCurrentGateReason: candidate.currentGateReason || "",
    });
  }
  const deltas = periodRows.map((row) => row.netAdaptiveDelta).filter(Number.isFinite);
  const benchmarkDeltas = periodRows.map((row) => row.netBenchmarkExcessDelta).filter(Number.isFinite);
  const universeDeltas = periodRows.map((row) => row.netUniverseExcessDelta).filter(Number.isFinite);
  const headerAudit = scoredHeaderAudit(options.baselineDir, options.candidateDir);
  return {
    summary: {
      candidateName: options.candidateName,
      candidateDir: options.candidateDir,
      commonPeriodCount: periodRows.length,
      avgNetAdaptiveDelta: mean(deltas),
      avgNetBenchmarkExcessDelta: mean(benchmarkDeltas),
      avgNetUniverseExcessDelta: mean(universeDeltas),
      bestNetAdaptiveDelta: deltas.length ? Math.max(...deltas) : null,
      worstNetAdaptiveDelta: deltas.length ? Math.min(...deltas) : null,
      improveWindowCount: deltas.filter((value) => value > minDelta).length,
      harmWindowCount: deltas.filter((value) => value < -minDelta).length,
      materialImprove3PctCount: deltas.filter((value) => value > 0.03).length,
      materialHarm3PctCount: deltas.filter((value) => value < -0.03).length,
      ...headerAudit,
    },
    periods: periodRows,
  };
}

function serializeRows(rows) {
  return rows.map((row) => {
    const result = {};
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === "number") result[key] = Number.isFinite(value) ? Number(value.toFixed(6)) : "";
      else result[key] = value == null ? "" : value;
    }
    return result;
  });
}

function run(args) {
  fs.mkdirSync(args.outDir, { recursive: true });
  const candidates = args.candidateDirs.map((candidate) => compareCandidate({
    baselineDir: args.baselineDir,
    candidateName: candidate.name,
    candidateDir: candidate.dir,
    minDelta: args.minDelta,
  }));
  const summaryRows = serializeRows(candidates.map((candidate) => candidate.summary))
    .sort((a, b) => Number(b.avgNetAdaptiveDelta || -Infinity) - Number(a.avgNetAdaptiveDelta || -Infinity));
  const periodRows = serializeRows(candidates.flatMap((candidate) => candidate.periods));
  if (summaryRows.length) writeCsv(path.join(args.outDir, "opportunity_summary.csv"), summaryRows, Object.keys(summaryRows[0]));
  if (periodRows.length) writeCsv(path.join(args.outDir, "period_opportunities.csv"), periodRows, Object.keys(periodRows[0]));
  const json = {
    generatedAt: new Date().toISOString(),
    baselineDir: args.baselineDir,
    minDelta: args.minDelta,
    candidates,
  };
  fs.writeFileSync(path.join(args.outDir, "opportunity_summary.json"), `${JSON.stringify(json, null, 2)}\n`);
  return json;
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      return;
    }
    const result = run(args);
    console.log(`Wrote opportunity miner output for ${result.candidates.length} candidates to ${args.outDir}`);
  } catch (error) {
    console.error(error.message);
    console.error("");
    console.error(usage());
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  compareCandidate,
  parseArgs,
  run,
};
