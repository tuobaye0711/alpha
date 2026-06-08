#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const {
  applyBenchmarkRelativeMetrics,
  applyCrossSectionalRankScore,
  applyDynamicGroupMetrics,
  applyIndustryMomentumMetrics,
  assignRecommendedWeights,
  clamp,
  entryTradability,
  marketSymbol,
  paramGrid,
  parseCsv,
  scoreAtDate,
  writeCsv,
} = require("./lib/backtest_engine");

const ALPHA_ROOT = path.resolve(__dirname, "..");
const DEFAULT_CACHE_DIR = path.join(ALPHA_ROOT, "cache", "kline");
const DEFAULT_OUTPUT_ROOT = path.join(ALPHA_ROOT, "output");
const DEFAULT_UNIVERSE_FILES = [
  path.join(ALPHA_ROOT, "output", "physical-ai-universe-20260604-1740", "physical_ai_core_candidates.csv"),
  path.join(ALPHA_ROOT, "output", "theme-universe-20260604-1700", "alpha_core_candidates.csv"),
  path.join(ALPHA_ROOT, "output", "theme-universe-20260604-1700", "hk_theme_candidates.csv"),
];
const DEFAULT_NAME_SOURCE_FILES = [
  ...DEFAULT_UNIVERSE_FILES,
  path.join(DEFAULT_OUTPUT_ROOT, "backtest-merged-v32-regime-v8-recovery-priority-stablebaseline-v51-margin1-17p-cacheonly-20260607-iter180", "scored_2025-02-05_2025-04-02.csv"),
  path.join(DEFAULT_OUTPUT_ROOT, "backtest-merged-v17-selective-v63-no-static-17p-cacheonly-lookback520-20260607", "scored_2025-02-05_2025-04-02.csv"),
];
const DEFAULT_PARAM = "rank_tradable_acceleration_balanced_v22_top15";
const DEFAULT_BACKTEST_STATS = {
  avgNetReturn: "11.23%",
  avgNetExcessBenchmark: "7.55%",
  avgNetExcessUniverse: "4.05%",
  pairedPValue: "0.0098",
};
const BENCHMARKS = {
  csi300: { symbol: "sh000300", name: "沪深300" },
  chinext: { symbol: "sz399006", name: "创业板指" },
  star50: { symbol: "sh000688", name: "科创50" },
  bse50: { symbol: "bj899050", name: "北证50", fallback: "csi300" },
  hstech: { symbol: "hkHSTECH", name: "恒生科技" },
};

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function round(value, digits = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(digits)) : "";
}

function pct(value, digits = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? `${(n * 100).toFixed(digits)}%` : "-";
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 100000000) return `${(n / 100000000).toFixed(2)}亿`;
  if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(2)}万`;
  return n.toFixed(0);
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseArgs(argv) {
  const args = {
    universeFiles: DEFAULT_UNIVERSE_FILES,
    cacheDir: DEFAULT_CACHE_DIR,
    outDir: path.join(DEFAULT_OUTPUT_ROOT, `current-alpha-selection-${timestamp()}`),
    asOf: "",
    lookbacks: [900, 520, 420],
    paramName: DEFAULT_PARAM,
    topN: null,
    selectedPool: "pitSz / relative-trend-crowding-v5",
    cashReservePct: 20,
    neutralTheme: false,
    nameSourceFiles: DEFAULT_NAME_SOURCE_FILES,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return argv[i];
    };
    if (arg === "--universe") {
      args.universeFiles = next().split(",").map((s) => path.resolve(s.trim())).filter(Boolean);
    } else if (arg === "--cache-dir") {
      args.cacheDir = path.resolve(next());
    } else if (arg === "--out-dir") {
      args.outDir = path.resolve(next());
    } else if (arg === "--as-of") {
      args.asOf = next();
    } else if (arg === "--lookbacks") {
      args.lookbacks = next().split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
    } else if (arg === "--param") {
      args.paramName = next();
    } else if (arg === "--top") {
      args.topN = Number(next());
    } else if (arg === "--selected-pool") {
      args.selectedPool = next();
    } else if (arg === "--cash-reserve-pct") {
      args.cashReservePct = Number(next());
    } else if (arg === "--neutral-theme") {
      args.neutralTheme = true;
    } else if (arg === "--name-source") {
      args.nameSourceFiles = next().split(",").map((s) => path.resolve(s.trim())).filter(Boolean);
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function usage() {
  return [
    "Usage: node build_current_alpha_selection_report.js [options]",
    "",
    "Options:",
    "  --universe <csv[,csv2]>",
    "  --cache-dir <dir>",
    "  --out-dir <dir>",
    "  --as-of <YYYY-MM-DD>",
    "  --lookbacks <900,520,420>",
    "  --param <paramName[_topN]>",
    "  --top <n>",
    "  --selected-pool <name>",
    "  --cash-reserve-pct <n>",
    "  --neutral-theme        关闭主题/概念加分；主题只作事后归因展示",
    "  --name-source <csv[,csv2]>  用历史CSV补全股票中文名/行业，仅影响展示",
  ].join("\n");
}

function splitTopSuffix(name) {
  const match = String(name || "").match(/^(.*)_top(\d+)$/);
  if (!match) return { baseName: String(name || ""), topN: null };
  return { baseName: match[1], topN: Number(match[2]) };
}

function selectParamConfig(name) {
  const { baseName, topN } = splitTopSuffix(name);
  const param = paramGrid().find((item) => item.name === baseName);
  if (!param) throw new Error(`Unknown param: ${name}`);
  return { param: { ...param }, topN };
}

function normalizeUniverseRow(row, file) {
  const code = String(row.code || row.SECURITY_CODE || row.symbol || "").trim();
  const market = row.market || row.board || row.MARKET || "";
  return {
    ...row,
    code,
    name: row.name || row.security_name_abbr || row.security_name || row.SECURITY_NAME_ABBR || "",
    market,
    industry: row.industry || row.行业 || "",
    theme: row.theme || "",
    concepts: row.concepts || row.concept || "",
    relevance: row.relevance || "",
    source: row.source || path.basename(file),
    universeSource: row.universeSource || row.source || path.basename(file),
  };
}

function canonicalCode(code, market = "") {
  const raw = String(code || "").trim();
  const digits = raw.replace(/\D/g, "");
  if (!digits) return raw;
  if (/港/.test(String(market || "")) || digits.length <= 5) return digits.padStart(5, "0");
  return digits.padStart(6, "0");
}

function isPlaceholderName(code, name) {
  const text = String(name || "").trim();
  if (!text) return true;
  if (/[\u4e00-\u9fff]/.test(text)) return false;
  const digits = String(code || "").replace(/\D/g, "");
  const compact = text.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!compact) return true;
  if (compact === digits) return true;
  if (["sz", "sh", "bj", "hk"].some((prefix) => compact === `${prefix}${digits}`)) return true;
  return /^(sz|sh|bj|hk)?\d+$/.test(compact);
}

function isGenericMarket(value) {
  return /^(深市|沪市|北交所\/新三板系|A股|)$/.test(String(value || "").trim());
}

function buildNameLookupFromRows(rows) {
  const lookup = new Map();
  for (const sourceRow of rows || []) {
    const row = normalizeUniverseRow(sourceRow, "name_source");
    const key = canonicalCode(row.code, row.market);
    if (!key || isPlaceholderName(row.code, row.name)) continue;
    const item = {
      name: String(row.name || "").trim(),
      market: String(row.market || "").trim(),
      industry: String(row.industry || "").trim(),
    };
    const existing = lookup.get(key);
    if (!existing) {
      lookup.set(key, item);
      continue;
    }
    if (!existing.industry && item.industry) existing.industry = item.industry;
    if (isGenericMarket(existing.market) && item.market) existing.market = item.market;
  }
  return lookup;
}

function readNameLookup(files) {
  const lookup = new Map();
  for (const file of files || []) {
    if (!file || !fs.existsSync(file)) continue;
    const fileLookup = buildNameLookupFromRows(parseCsv(fs.readFileSync(file, "utf8")));
    for (const [key, item] of fileLookup.entries()) {
      const existing = lookup.get(key);
      if (!existing) {
        lookup.set(key, { ...item });
        continue;
      }
      if (!existing.industry && item.industry) existing.industry = item.industry;
      if (isGenericMarket(existing.market) && item.market) existing.market = item.market;
    }
  }
  return lookup;
}

function applyNameLookup(rows, lookup) {
  if (!lookup?.size) return rows;
  return rows.map((row) => {
    const key = canonicalCode(row.code, row.market);
    const item = lookup.get(key);
    if (!item) return row;
    const next = { ...row };
    if (isPlaceholderName(row.code, row.name)) next.name = item.name;
    if (!next.industry && item.industry) next.industry = item.industry;
    if (isGenericMarket(next.market) && item.market) next.market = item.market;
    return next;
  });
}

function mergeText(a, b) {
  const values = new Set();
  for (const text of [a, b]) {
    for (const part of String(text || "").split(/[|,，、]/).map((s) => s.trim()).filter(Boolean)) values.add(part);
  }
  return Array.from(values).join("|");
}

function readUniverse(files) {
  const byCode = new Map();
  for (const file of files) {
    const rows = parseCsv(fs.readFileSync(file, "utf8")).map((row) => normalizeUniverseRow(row, file));
    for (const row of rows) {
      if (!row.code) continue;
      const key = row.market === "港股通" || /^\d{5}$/.test(row.code) ? row.code.padStart(5, "0") : row.code.padStart(6, "0");
      const existing = byCode.get(key);
      if (!existing) {
        byCode.set(key, { ...row, code: key });
        continue;
      }
      existing.theme = mergeText(existing.theme, row.theme);
      existing.concepts = mergeText(existing.concepts, row.concepts);
      existing.source = mergeText(existing.source, row.source);
      existing.universeSource = mergeText(existing.universeSource, row.universeSource);
      existing.relevance = mergeText(existing.relevance, row.relevance);
      if (!existing.industry && row.industry) existing.industry = row.industry;
      if (!existing.name && row.name) existing.name = row.name;
      if (!existing.market && row.market) existing.market = row.market;
    }
  }
  return Array.from(byCode.values());
}

function meaningfulThemeText(row) {
  const values = [];
  for (const text of [row.concepts, row.theme]) {
    for (const raw of String(text || "").split(/[|,，、]/).map((s) => s.trim()).filter(Boolean)) {
      const lower = raw.toLowerCase();
      if (/cache_wide|cache_|local_kline|generated_from|market_variant/.test(lower)) continue;
      if (/\.csv$/.test(lower)) continue;
      if (/candidates?$/.test(lower)) continue;
      values.push(raw);
    }
  }
  return Array.from(new Set(values)).slice(0, 2).join("/");
}

function cacheFileForSymbol(cacheDir, symbol, lookback) {
  return path.join(cacheDir, "tencent", `${symbol}_${lookback}_qfq.json`);
}

function benchmarkCacheFile(cacheDir, symbol, lookback) {
  const safe = String(symbol).replace(/[^A-Za-z0-9_.-]/g, "_");
  return path.join(cacheDir, "benchmark", `${safe}_${lookback}.json`);
}

function readKlineFromCache(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const payload = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(payload.kline) ? payload.kline : null;
  } catch {
    return null;
  }
}

function loadKline(row, args) {
  const symbol = marketSymbol(row);
  for (const lookback of args.lookbacks) {
    const kline = readKlineFromCache(cacheFileForSymbol(args.cacheDir, symbol, lookback));
    if (kline?.length) return { symbol, lookback, kline };
  }
  return { symbol, lookback: null, kline: null };
}

function benchmarkDefForRow(row) {
  const market = String(row.market || "");
  const code = String(row.code || "");
  if (/港/.test(market) || /^\d{5}$/.test(code)) return BENCHMARKS.hstech;
  if (/创业/.test(market) || /^(300|301)/.test(code)) return BENCHMARKS.chinext;
  if (/科创/.test(market) || /^(688|689)/.test(code)) return BENCHMARKS.star50;
  if (/北交|新三板/.test(market) || /^(8|4|920)/.test(code)) return BENCHMARKS.bse50;
  return BENCHMARKS.csi300;
}

function benchmarkNameForRow(row) {
  return benchmarkDefForRow(row).name;
}

function loadBenchmarkKlines(universe, args) {
  const symbols = new Set();
  for (const row of universe) {
    const def = benchmarkDefForRow(row);
    symbols.add(def.symbol);
    if (def.fallback) symbols.add(BENCHMARKS[def.fallback].symbol);
  }
  const out = new Map();
  for (const symbol of symbols) {
    for (const lookback of args.lookbacks) {
      const kline = readKlineFromCache(benchmarkCacheFile(args.cacheDir, symbol, lookback));
      if (kline?.length) {
        out.set(symbol, kline);
        break;
      }
    }
  }
  return out;
}

function benchmarkKlineForRow(row, benchmarkKlines) {
  const def = benchmarkDefForRow(row);
  return benchmarkKlines.get(def.symbol) || (def.fallback ? benchmarkKlines.get(BENCHMARKS[def.fallback].symbol) : null);
}

function latestCommonAsOf(loaded) {
  const counts = new Map();
  for (const item of loaded) {
    const last = item.kline?.filter((row) => row.date)?.at(-1)?.date;
    if (!last) continue;
    counts.set(last, (counts.get(last) || 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0]?.[0] || "";
}

function scoreCurrentUniverse({ universe, loadedByCode, benchmarkKlines, asOf, param }) {
  let scored = [];
  const skipped = [];
  for (const row of universe) {
    const loaded = loadedByCode.get(row.code);
    if (!loaded?.kline?.length) {
      skipped.push({ code: row.code, name: row.name, reason: "missing_kline" });
      continue;
    }
    const score = scoreAtDate(row, loaded.kline, asOf, param);
    if (score.status !== "scored") {
      skipped.push({ code: row.code, name: row.name, reason: score.reason, historyDays: score.historyDays });
      continue;
    }
    const benchmark = benchmarkKlineForRow(row, benchmarkKlines);
    if (benchmark) applyBenchmarkRelativeMetrics(score, benchmark, asOf, param);
    const tradability = entryTradability(score, loaded.kline, asOf, { enabled: true, minTurnover: 0 });
    if (!tradability.tradable) {
      skipped.push({
        code: row.code,
        name: row.name,
        reason: tradability.reason,
        historyDays: score.historyDays,
        entryDayReturn: tradability.entryDayReturn,
        entryTurnover: tradability.entryTurnover,
      });
      continue;
    }
    score.entryDayReturn = tradability.entryDayReturn;
    score.entryTurnover = tradability.entryTurnover;
    score.entryCloseAtHigh = tradability.entryCloseAtHigh;
    score.cacheSymbol = loaded.symbol;
    score.cacheLookback = loaded.lookback;
    score.benchmarkName = benchmarkNameForRow(row);
    score.theme = row.theme || "";
    score.reasonText = row.reason || "";
    scored.push(score);
  }
  applyIndustryMomentumMetrics(scored, param);
  applyDynamicGroupMetrics(scored, param.dynamicGroupMetrics || {});
  if (param.rankBlend) applyCrossSectionalRankScore(scored, param);
  scored = scored.slice().sort((a, b) => b.score - a.score);
  return { scored, skipped };
}

function explainSelection(row) {
  const reasons = [];
  if (Number(row.relativeR20) >= 0.06) reasons.push("20日相对强");
  else if (Number(row.relativeR20) >= 0.02) reasons.push("相对大盘略强");
  if (Number(row.r20) >= 0.12 && Number(row.r60) >= 0.12) reasons.push("中短趋势共振");
  else if (Number(row.r20) >= 0.12) reasons.push("短期趋势强");
  if (Number(row.volumeMomentumScore) >= 70) reasons.push("量能确认");
  if (Number(row.freshTrendScore) >= 75) reasons.push("新趋势强");
  if (Number(row.turnoverStabilityScore) >= 68) reasons.push("换手稳定");
  if (Number(row.lotterySpikeScore) >= 88) reasons.push("尖峰风险可控");
  if (row.industry) reasons.push(`${row.industry}方向`);
  const theme = meaningfulThemeText(row);
  if (theme) reasons.push(`主题：${theme}`);
  return reasons.length ? reasons.join("；") : "综合量价、相对强弱、流动性和主题暴露进入Top组合";
}

function signedPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  const rounded = Math.round(n * 100);
  return `${rounded >= 0 ? "+" : ""}${rounded}%`;
}

function triangularScore(value, low, peak, high, fallback = 0.5) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n <= low || n >= high) return 0;
  if (n === peak) return 1;
  if (n < peak) return clamp((n - low) / Math.max(0.001, peak - low), 0, 1);
  return clamp((high - n) / Math.max(0.001, high - peak), 0, 1);
}

function futureEdgeProfile(row) {
  const modelScore = clamp(Number(row.modelScore ?? row.score ?? 50));
  const r5 = Number(row.r5);
  const r20 = Number(row.r20);
  const r60 = Number(row.r60);
  const relativeR20 = Number(row.relativeR20);
  const volumeMomentum = clamp(Number(row.volumeMomentumScore ?? 50));
  const turnoverStability = clamp(Number(row.turnoverStabilityScore ?? 50));
  const freshTrend = clamp(Number(row.freshTrendScore ?? 50));
  const lottery = clamp(Number(row.lotterySpikeScore ?? 88));
  const maxDailyReturn20 = Number(row.maxDailyReturn20);
  const vol20 = Number(row.vol20);
  const isSpecialTreatment = /(^|\*)ST|退市/i.test(String(row.name || ""));

  const r20SweetSpot = triangularScore(r20, -0.02, 0.12, 0.26, 0.35);
  const r60SweetSpot = triangularScore(r60, 0.00, 0.24, 0.58, 0.35);
  const relativeSweetSpot = triangularScore(relativeR20, 0.00, 0.07, 0.20, 0.35);
  const volumeScore = clamp((volumeMomentum - 45) / 45, 0, 1);
  const stabilityScore = clamp((turnoverStability - 45) / 45, 0, 1);
  const freshScore = clamp((freshTrend - 45) / 45, 0, 1);
  const spikeSafety = clamp((lottery - 55) / 45, 0, 1);

  const r5Overheat = Number.isFinite(r5) ? clamp((r5 - 0.09) / 0.11, 0, 1) : 0;
  const r20Overheat = Number.isFinite(r20) ? clamp((r20 - 0.24) / 0.22, 0, 1) : 0;
  const r60Overheat = Number.isFinite(r60) ? clamp((r60 - 0.58) / 0.55, 0, 1) : 0;
  const spikeOverheat = Number.isFinite(maxDailyReturn20) ? clamp((maxDailyReturn20 - 0.11) / 0.10, 0, 1) : 0;
  const volOverheat = Number.isFinite(vol20) ? clamp((vol20 - 0.72) / 0.30, 0, 1) : 0;
  const overheatPenalty = clamp(
    r5Overheat * 0.22 +
      r20Overheat * 0.34 +
      r60Overheat * 0.24 +
      spikeOverheat * 0.12 +
      volOverheat * 0.08,
    0,
    1
  );

  const volatilityRisk = Number.isFinite(vol20) ? clamp((vol20 - 0.52) / 0.48, 0, 1) : 0.35;
  const spikeRisk = 1 - spikeSafety;
  const riskPenalty = clamp(volatilityRisk * 0.52 + spikeRisk * 0.28 + overheatPenalty * 0.20, 0, 1);
  const potentialUpside = clamp(
    0.03 +
      r20SweetSpot * 0.055 +
      r60SweetSpot * 0.025 +
      relativeSweetSpot * 0.045 +
      volumeScore * 0.018 +
      freshScore * 0.020 +
      (modelScore / 100) * 0.020 -
      overheatPenalty * 0.075 -
      riskPenalty * 0.030,
    -0.04,
    0.22
  );
  const expectedDrawdown = clamp(0.045 + volatilityRisk * 0.075 + overheatPenalty * 0.085 + spikeRisk * 0.035, 0.035, 0.24);
  const payoffRiskRatio = clamp(potentialUpside / Math.max(0.01, expectedDrawdown), -1, 4);
  let futureEdgeScore = clamp(
    24 +
      (modelScore / 100) * 16 +
      r20SweetSpot * 20 +
      relativeSweetSpot * 15 +
      r60SweetSpot * 9 +
      volumeScore * 8 +
      stabilityScore * 7 +
      freshScore * 8 +
      spikeSafety * 6 +
      clamp(payoffRiskRatio / 3, 0, 1) * 13 -
      overheatPenalty * 38 -
      riskPenalty * 15,
    0,
    100
  );

  let opportunityBucket = "观察/降权";
  if (isSpecialTreatment) {
    futureEdgeScore = Math.min(futureEdgeScore, 35);
    opportunityBucket = "观察/降权";
  } else if (overheatPenalty >= 0.55 || r20 >= 0.40 || r60 >= 0.90 || (r5 >= 0.13 && maxDailyReturn20 >= 0.12)) {
    opportunityBucket = "强势不追";
  } else if (futureEdgeScore >= 72 && overheatPenalty < 0.34) {
    opportunityBucket = "明日可试仓";
  } else if (futureEdgeScore >= 62) {
    opportunityBucket = "等待回踩确认";
  }

  return {
    modelScore: Number(modelScore.toFixed(4)),
    futureEdgeScore: Number(futureEdgeScore.toFixed(4)),
    overheatPenalty: Number(overheatPenalty.toFixed(4)),
    riskPenalty: Number(riskPenalty.toFixed(4)),
    potentialUpside: Number(potentialUpside.toFixed(6)),
    expectedDrawdown: Number(expectedDrawdown.toFixed(6)),
    payoffRiskRatio: Number(payoffRiskRatio.toFixed(4)),
    opportunityBucket,
  };
}

function rankByFutureEdge(rows) {
  return rows
    .map((row) => {
      const profile = futureEdgeProfile(row);
      return {
        ...row,
        ...profile,
        score: profile.futureEdgeScore,
      };
    })
    .sort((a, b) => b.futureEdgeScore - a.futureEdgeScore || b.modelScore - a.modelScore);
}

function estimateExpectedExcessRange(row, options = {}) {
  const profile = Number.isFinite(Number(row.futureEdgeScore)) ? row : futureEdgeProfile(row);
  const vol20 = Number(row.vol20);

  let center = -0.01 + (Number(profile.futureEdgeScore || 50) / 100) * 0.13;
  center -= Number(profile.overheatPenalty || 0) * 0.035;
  center -= Number(profile.riskPenalty || 0) * 0.018;
  center = clamp(center, -0.04, 0.16);

  const riskWidth = 0.025 + clamp(((vol20 || 0.55) - 0.45) / 0.65, 0, 1) * 0.030 + Number(profile.overheatPenalty || 0) * 0.015;
  const low = clamp(center - riskWidth, -0.06, 0.18);
  const high = clamp(center + riskWidth, -0.02, 0.22);
  const benchmarkName = options.benchmarkName || row.benchmarkName || "映射基准";
  const basis = "未来值搏率：原始模型分 + 温和强势/相对转强 + 量能/换手稳定 - 近期涨幅过热/高波动/尖峰风险折扣";
  return {
    low,
    high,
    center,
    lower: low,
    upper: high,
    basis,
    label: `相对${benchmarkName}：${signedPct(low)}至${signedPct(high)}`,
  };
}

function formatExpectedExcessRange(value) {
  if (value && typeof value === "object" && value.basis) return value.label;
  if (value && typeof value === "object" && value.label) return `相对基准：${value.label}`;
  const text = String(value || "").trim();
  if (!text) return "相对基准：+4%至+10%";
  if (/相对.*基准/.test(text)) return text;
  return `相对基准：${text.replace(/-/g, "至")}`;
}

function formatHoldingPlan(row, options = {}) {
  const expectedExcessRange = options.expectedExcessRange || estimateExpectedExcessRange(row, { benchmarkName: options.benchmarkName });
  const holdingPeriod = options.holdingPeriod || "6-8周";
  const weightPct = `${Number(row.recommendedWeightPct || 0).toFixed(2)}%`;
  const profile = row.opportunityBucket ? row : futureEdgeProfile(row);
  const entryDayReturn = Number(row.entryDayReturn);
  const r20 = Number(row.r20);
  const relativeR20 = Number(row.relativeR20);
  const vol20 = Number(row.vol20);
  const lottery = Number(row.lotterySpikeScore);
  let buyPlan = "分批试仓，盘中不追急拉";
  if (/强势不追/.test(profile.opportunityBucket)) buyPlan = "不追高，等回踩/横盘消化后再评估";
  else if (/等待回踩/.test(profile.opportunityBucket)) buyPlan = "等待回踩承接或缩量横盘后再试仓";
  else if (/明日可试仓/.test(profile.opportunityBucket)) buyPlan = "分批小仓试错，确认承接后再加";
  else if (entryDayReturn >= 0.06) buyPlan = "高开或急拉不追，等回落承接后再试仓";
  else if (relativeR20 >= 0.08 && Number(row.volumeMomentumScore) >= 70) buyPlan = "分批试仓，放量突破可加一档";
  else if (r20 < 0) buyPlan = "只观察，等重新站回20日强势区再买";
  let riskControl = "跌破20日相对强趋势或连续两日弱于对应指数则降仓";
  if (/强势不追/.test(profile.opportunityBucket)) riskControl = "若继续加速但无新增催化，赔率继续下降；回撤不缩量则放弃";
  else if (vol20 >= 0.75 || lottery < 85) riskControl = "波动/尖峰偏高，只做轻仓；跌破5日趋势或冲高回落放量即降仓";
  return {
    weightPct,
    holdingPeriod,
    expectedExcess: formatExpectedExcessRange(expectedExcessRange),
    expectedExcessBasis: expectedExcessRange.basis || "外部指定区间",
    buyPlan,
    riskControl,
  };
}

function csvRows(rows) {
  return rows.map((row, index) => ({
    rank: index + 1,
    code: row.code,
    name: row.name,
    market: row.market,
    industry: row.industry,
    priceAsOf: round(row.priceAsOf, 3),
    score: round(row.score, 4),
    recommendedWeightPct: round(row.recommendedWeightPct, 4),
    r5: round(row.r5, 6),
    r20: round(row.r20, 6),
    r60: round(row.r60, 6),
    relativeR20: round(row.relativeR20, 6),
    relativeMomentumScore: round(row.relativeMomentumScore, 4),
    modelScore: round(row.modelScore, 4),
    futureEdgeScore: round(row.futureEdgeScore, 4),
    opportunityBucket: row.opportunityBucket,
    overheatPenalty: round(row.overheatPenalty, 4),
    payoffRiskRatio: round(row.payoffRiskRatio, 4),
    potentialUpside: round(row.potentialUpside, 6),
    expectedDrawdown: round(row.expectedDrawdown, 6),
    volumeMomentumScore: round(row.volumeMomentumScore, 4),
    turnoverStabilityScore: round(row.turnoverStabilityScore, 4),
    freshTrendScore: round(row.freshTrendScore, 4),
    lotterySpikeScore: round(row.lotterySpikeScore, 4),
    maxDailyReturn20: round(row.maxDailyReturn20, 6),
    vol20: round(row.vol20, 6),
    avgTurnover20: round(row.avgTurnover20, 2),
    entryDayReturn: round(row.entryDayReturn, 6),
    theme: row.theme,
    concepts: row.concepts,
    reason: row.reason,
    buyPlan: row.buyPlan,
    riskControl: row.riskControl,
    expectedExcess: row.expectedExcess,
    expectedExcessBasis: row.expectedExcessBasis,
    holdingPeriod: row.holdingPeriod,
  }));
}

function renderHtmlReport(report) {
  const rows = report.rows || [];
  const caveats = report.caveats || [];
  const iterations = report.iterations || [];
  const eventChecks = report.eventChecks || [];
  const rowHtml = rows.map((row) => `
    <tr>
      <td class="rank">${row.rank}</td>
      <td><strong>${htmlEscape(row.name)}</strong><span>${htmlEscape(row.code)} · ${htmlEscape(row.market)}</span></td>
      <td>${htmlEscape(row.industry || "-")}</td>
      <td class="num">${htmlEscape(row.weightPct || pct(row.recommendedWeightPct / 100))}</td>
      <td class="num">${htmlEscape(String(round(row.futureEdgeScore ?? row.score, 1)))}<span>${htmlEscape(row.opportunityBucket || "")}</span></td>
      <td class="num">${pct(row.r20)}</td>
      <td class="num">${pct(row.relativeR20)}</td>
      <td>${htmlEscape(row.reason)}</td>
      <td>${htmlEscape(row.buyPlan)}</td>
      <td>${htmlEscape(row.riskControl)}</td>
      <td>${htmlEscape(row.expectedExcess)}<span>${htmlEscape(row.expectedExcessBasis || "")}</span></td>
      <td>${htmlEscape(row.holdingPeriod)}</td>
    </tr>`).join("");
  const caveatHtml = caveats.map((item) => `<li>${htmlEscape(item)}</li>`).join("");
  const iterationHtml = iterations.map((item) => `
    <tr>
      <td><strong>${htmlEscape(item.version)}</strong><span>${htmlEscape(item.scope || "")}</span></td>
      <td>${htmlEscape(item.attempt)}</td>
      <td>${htmlEscape(item.result)}</td>
      <td>${htmlEscape(item.lift)}</td>
      <td>${htmlEscape(item.status)}</td>
    </tr>`).join("");
  const eventCheckHtml = eventChecks.map((item) => `
    <div class="event-card">
      <strong>${htmlEscape(item.title)}</strong>
      <p>${htmlEscape(item.facts)}</p>
      <p><span>Alpha 影响：</span>${htmlEscape(item.impact)}</p>
      <p><span>反证：</span>${htmlEscape(item.risk)}</p>
    </div>`).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${htmlEscape(report.title)}</title>
  <style>
    :root { color-scheme: light; --bg:#f5f2ea; --panel:#fffdf7; --ink:#181714; --muted:#6f685d; --line:#ded6c8; --red:#b42318; --green:#087443; --blue:#2457a6; --gold:#a66f00; }
    * { box-sizing: border-box; }
    body { margin:0; font-family:Georgia,"Times New Roman","Songti SC","Noto Serif CJK SC",serif; background:linear-gradient(180deg,#efe6d6 0,#f8f5ee 260px,#f5f2ea 100%); color:var(--ink); overflow-x:hidden; }
    header { padding:32px 32px 20px; background:#17140f; color:#fff7e6; border-bottom:5px solid #c48a1b; }
    header h1 { margin:0 0 10px; font-size:30px; font-weight:760; letter-spacing:0; overflow-wrap:anywhere; }
    header p { margin:4px 0; color:#e8dcc8; font-size:14px; overflow-wrap:anywhere; }
    main { padding:24px 32px 36px; max-width:1480px; margin:0 auto; }
    .summary { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin-bottom:18px; }
    .metric { min-width:0; background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px 16px; box-shadow:0 10px 28px rgba(72,55,31,0.06); }
    .metric label { display:block; color:var(--muted); font-size:12px; margin-bottom:8px; }
    .metric strong { font-size:22px; }
    .legend { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; margin-bottom:18px; }
    .legend div { min-width:0; background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:12px 14px; box-shadow:0 10px 28px rgba(72,55,31,0.05); }
    .legend strong { display:block; margin-bottom:6px; font-size:14px; }
    .legend p { margin:0; color:#4b5563; font-size:13px; line-height:1.55; overflow-wrap:anywhere; word-break:break-word; }
    .event-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:12px; padding:14px; }
    .event-card { border:1px solid var(--line); border-radius:8px; padding:12px 14px; background:#fffaf0; }
    .event-card strong { display:block; margin-bottom:8px; color:#2b2113; }
    .event-card p { margin:6px 0 0; color:#4d4336; font-size:13px; line-height:1.55; overflow-wrap:anywhere; }
    .event-card span { color:#8a5d00; font-weight:700; }
    section { background:var(--panel); border:1px solid var(--line); border-radius:8px; margin-top:16px; overflow:hidden; max-width:100%; min-width:0; box-shadow:0 14px 34px rgba(72,55,31,0.07); }
    section h2 { margin:0; padding:14px 16px; font-size:16px; border-bottom:1px solid var(--line); }
    .table-scroll { width:100%; overflow-x:auto; }
    table { width:100%; min-width:1320px; border-collapse:collapse; table-layout:fixed; }
    th, td { padding:10px 10px; border-bottom:1px solid var(--line); vertical-align:top; font-size:13px; line-height:1.45; }
    th { text-align:left; color:#5c5142; background:#f3eadc; font-weight:650; }
    td span { display:block; color:var(--muted); margin-top:2px; font-size:12px; }
    .rank { font-weight:700; color:var(--blue); }
    .num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
    .notes { padding:14px 18px 16px; color:#374151; }
    .notes li { margin:6px 0; }
    .positive { color:var(--green); }
    .warn { color:var(--red); }
    @media (max-width: 900px) {
      header, main { padding-left:14px; padding-right:14px; }
      header h1 { font-size:24px; line-height:1.25; word-break:break-word; }
      header p { word-break:break-all; }
      .legend p { word-break:break-all; }
      .summary { grid-template-columns:repeat(2,minmax(0,1fr)); }
      .legend { grid-template-columns:1fr; }
      table { min-width:1280px; }
    }
    @media (max-width: 520px) {
      .summary { grid-template-columns:1fr; }
    }
  </style>
</head>
<body>
  <header>
    <h1>${htmlEscape(report.title)}</h1>
    <p>生成时间：${htmlEscape(report.generatedAt)} · asOf：${htmlEscape(report.asOf)} · 股票池：${htmlEscape(report.selectedPool)} · 算法：${htmlEscape(report.selectedParam)}</p>
    <p>定位：明日参考的进攻候选组合，不是自动交易指令。</p>
  </header>
  <main>
    <div class="summary">
      <div class="metric"><label>历史同口径平均净收益</label><strong>${htmlEscape(report.backtestSummary.avgNetReturn)}</strong></div>
      <div class="metric"><label>历史净超大盘</label><strong class="positive">${htmlEscape(report.backtestSummary.avgNetExcessBenchmark)}</strong></div>
      <div class="metric"><label>统计边界 p 值</label><strong>${htmlEscape(report.backtestSummary.pairedPValue)}</strong></div>
      <div class="metric"><label>冻结股票池</label><strong>${htmlEscape(String(report.universeCount ?? "-"))}</strong></div>
      <div class="metric"><label>成功评分</label><strong>${htmlEscape(String(report.scoredCount ?? "-"))}</strong></div>
      <div class="metric"><label>跳过/不可交易</label><strong>${htmlEscape(String(report.skippedCount ?? "-"))}</strong></div>
      <div class="metric"><label>现金/机动仓</label><strong>${htmlEscape(report.cashReservePct || "20%")}</strong></div>
    </div>
    <div class="legend">
      <div><strong>近20交易日涨跌</strong><p>指最近20个交易日内，该股 asOf 收盘价相对20个交易日前收盘价的涨跌幅。它不是20日均线，也不是未来20日预测。</p></div>
      <div><strong>相对基准20日超额</strong><p>指该股近20交易日涨跌幅减去映射基准指数同期涨跌幅。创业板默认对创业板指，科创对科创50，港股通对恒生科技，普通A股对沪深300。</p></div>
      <div><strong>未来值搏率怎么来</strong><p>先保留原始模型分，再优先奖励温和强势、相对转强、量能/换手稳定；对近20日/60日涨幅过大、高波动和尖峰行情做强扣分。</p></div>
    </div>
    ${eventCheckHtml ? `<section>
      <h2>Top 候选事件核验</h2>
      <div class="event-grid">${eventCheckHtml}</div>
    </section>` : ""}
    ${iterationHtml ? `<section>
      <h2>算法迭代与收益变化</h2>
      <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th style="width:130px">版本</th>
            <th style="width:310px">做了什么尝试</th>
            <th style="width:300px">结果</th>
            <th style="width:220px">相对上一关键版本</th>
            <th style="width:180px">结论</th>
          </tr>
        </thead>
        <tbody>${iterationHtml}</tbody>
      </table>
      </div>
    </section>` : ""}
    <section>
      <h2>当前 Top 股票池与资金分配</h2>
      <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th style="width:40px">#</th>
            <th style="width:140px">股票</th>
            <th style="width:86px">行业</th>
            <th style="width:66px">仓位</th>
            <th style="width:76px">值搏率/状态</th>
            <th style="width:86px">近20交易日涨跌</th>
            <th style="width:96px">相对基准20日超额</th>
            <th style="width:230px">投资原因</th>
            <th style="width:165px">买入计划</th>
            <th style="width:190px">风控</th>
            <th style="width:140px">预期超额区间</th>
            <th style="width:70px">持仓</th>
          </tr>
        </thead>
        <tbody>${rowHtml}</tbody>
      </table>
      </div>
    </section>
    <section>
      <h2>使用边界</h2>
      <ul class="notes">
        <li>“近20交易日涨跌”指最近20个交易日个股自身区间涨跌；“相对基准20日超额”指同期相对映射指数的超额表现。</li>
        ${caveatHtml}
      </ul>
    </section>
  </main>
</body>
</html>`;
}

function buildReport(args) {
  const { param, topN: topFromParam } = selectParamConfig(args.paramName);
  if (args.neutralTheme) {
    param.staticThemeScore = false;
    param.themeWeight = 0;
    param.rankThemeWeight = 0;
  }
  const topN = args.topN || topFromParam || 12;
  const nameLookup = readNameLookup(args.nameSourceFiles);
  const universe = applyNameLookup(readUniverse(args.universeFiles), nameLookup);
  const loaded = universe.map((row) => ({ row, ...loadKline(row, args) }));
  const asOf = args.asOf || latestCommonAsOf(loaded);
  if (!asOf) throw new Error("Cannot determine asOf from local kline cache");
  const loadedByCode = new Map(loaded.map((item) => [item.row.code, item]));
  const benchmarkKlines = loadBenchmarkKlines(universe, args);
  const { scored, skipped } = scoreCurrentUniverse({
    universe,
    loadedByCode,
    benchmarkKlines,
    asOf,
    param,
  });
  const ranked = rankByFutureEdge(scored);
  const weighted = assignRecommendedWeights(ranked.slice(0, topN), {
    ...(param.weighting || {}),
    minWeight: Math.max(0.04, Math.min(0.08, (param.weighting?.minWeight ?? 0.06))),
    maxWeight: Math.min(0.12, param.weighting?.maxWeight ?? 0.12),
  });
  const investablePct = Math.max(0, Math.min(100, 100 - Number(args.cashReservePct || 0)));
  const rows = weighted.map((row, index) => {
    const scaledWeight = row.recommendedWeightPct * investablePct / 100;
    const plan = formatHoldingPlan({ ...row, recommendedWeightPct: scaledWeight }, {
      holdingPeriod: "6-8周",
      benchmarkName: row.benchmarkName,
    });
    return {
      ...row,
      rank: index + 1,
      recommendedWeightPct: scaledWeight,
      reason: explainSelection(row),
      ...plan,
    };
  });
  return {
    title: "Alpha 当前选股与明日参考组合",
    generatedAt: new Date().toISOString(),
    asOf,
    selectedPool: args.selectedPool,
    selectedParam: `${args.paramName} / FutureEdge未来值搏率${args.neutralTheme ? " / 主题中性" : ""}`,
    backtestSummary: DEFAULT_BACKTEST_STATS,
    universeCount: universe.length,
    scoredCount: ranked.length,
    skippedCount: skipped.length,
    nameSourceCount: nameLookup.size,
    cashReservePct: `${Number(args.cashReservePct || 0).toFixed(0)}%`,
    rows,
    scored: ranked,
    skipped,
    caveats: [
      "当前腾讯日线缓存最新交易日为报告 asOf；若 2026-06-08 盘后数据未进入缓存，明天开盘前必须补看 6 月 8 日涨跌、成交和公告。",
      args.neutralTheme
        ? "本报告已关闭主题/概念加分，题材只作事后解释；因此不会因为用户偏好物理 AI 而额外加分。"
        : "本报告仍使用主题/概念字段参与评分；若要避免偏好题材影响，请使用 --neutral-theme 重跑。",
      `中文名/行业使用本地历史候选与回测CSV补全，仅影响展示，不参与评分；本次可用映射 ${nameLookup.size} 条。`,
      "本报告先用当前 strict PIT 三池 v5 研究线生成候选，再用 FutureEdge 二次排序：温和强势和相对转强加分，近20日/60日涨幅过热、高波动和尖峰行情降权。",
      "历史同口径 v5 结果来自 21 个 strict known-outcome 窗口，含 warmup 平均净收益/净超大盘为 11.23%/7.55%，相对 fixed pitSz 平均 +3.15pct，近似 p≈0.0098；这只是历史概率优势，不是收益承诺。",
      "仓位是组合占比，不是实盘指令；如果已有同主题持仓，需要把相关仓位合并计算，避免单一主题暴露过高。",
    ],
  };
}

function writeReport(report, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const topRows = csvRows(report.rows);
  const scoredRows = csvRows(report.scored.slice(0, 200));
  writeCsv(path.join(outDir, "current_top_selection.csv"), topRows, Object.keys(topRows[0] || {}));
  writeCsv(path.join(outDir, "current_scored_top200.csv"), scoredRows, Object.keys(scoredRows[0] || {}));
  writeCsv(path.join(outDir, "current_skipped.csv"), report.skipped, Object.keys(report.skipped[0] || { code: "", name: "", reason: "" }));
  fs.writeFileSync(path.join(outDir, "current_selection_report.json"), JSON.stringify({
    ...report,
    scored: undefined,
    skipped: undefined,
  }, null, 2));
  fs.writeFileSync(path.join(outDir, "current_selection_report.html"), renderHtmlReport(report));
}

function run(args) {
  const report = buildReport(args);
  writeReport(report, args.outDir);
  console.log(`[alpha-current] out=${args.outDir}`);
  console.log(`[alpha-current] asOf=${report.asOf} universe=${report.universeCount} scored=${report.scoredCount} skipped=${report.skippedCount}`);
  console.log(`[alpha-current] html=${path.join(args.outDir, "current_selection_report.html")}`);
  console.log(`[alpha-current] top=${report.rows.map((row) => `${row.code}${row.name}`).join(",")}`);
  return report;
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
    } else {
      run(args);
    }
  } catch (error) {
    console.error(`[alpha-current] ${error.stack || error.message}`);
    process.exit(1);
  }
}

module.exports = {
  applyNameLookup,
  buildNameLookupFromRows,
  buildReport,
  estimateExpectedExcessRange,
  explainSelection,
  formatHoldingPlan,
  futureEdgeProfile,
  parseArgs,
  rankByFutureEdge,
  renderHtmlReport,
  run,
  selectParamConfig,
  writeReport,
};
