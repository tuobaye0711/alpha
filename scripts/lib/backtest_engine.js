const fs = require("fs");
const path = require("path");

function num(value, fallback = null) {
  if (value == null || value === "" || value === "-") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(x, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, x));
}

function mean(xs) {
  const values = xs.filter((x) => Number.isFinite(x));
  return values.length ? values.reduce((sum, x) => sum + x, 0) / values.length : null;
}

function variance(xs) {
  const values = xs.filter((x) => Number.isFinite(x));
  if (values.length < 2) return 0;
  const m = mean(values);
  return values.reduce((sum, x) => sum + (x - m) ** 2, 0) / (values.length - 1);
}

function stddev(xs) {
  return Math.sqrt(variance(xs));
}

function parseCsvLine(line) {
  const cells = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') {
      if (line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (c === "," && !quoted) {
      cells.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  return cells;
}

function parseCsv(text) {
  const lines = text.trim().split(/\n/).filter(Boolean);
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const row = {};
    headers.forEach((header, i) => {
      row[header] = cells[i] ?? "";
    });
    return row;
  });
}

function csvEscape(value) {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(file, rows, headers) {
  fs.writeFileSync(
    file,
    [headers.join(","), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))].join("\n")
  );
}

const SCORING_USED_UNIVERSE_FIELDS = new Set([
  "code",
  "security_code",
  "symbol",
  "name",
  "security_name_abbr",
  "security_name",
  "market",
  "industry",
  "concepts",
  "relevance",
  "source",
]);

function classifyUniverseField(field) {
  const key = String(field || "").toLowerCase();
  if (["code", "security_code", "symbol"].includes(key)) {
    return { classification: "identifier", riskLevel: "low", pointInTimeStatus: "safe_identifier" };
  }
  if (["name", "security_name_abbr", "security_name", "market"].includes(key)) {
    return { classification: "descriptive_market_metadata", riskLevel: "low", pointInTimeStatus: "usually_stable_verify_if_old" };
  }
  if (["price", "pct_chg", "pctchg", "amount", "turnover", "turnover_rate", "volume"].includes(key)) {
    return { classification: "current_market_snapshot", riskLevel: "high", pointInTimeStatus: "must_be_ignored_or_historical" };
  }
  if (["pe", "pb", "ps", "roe", "total_mv", "circ_mv", "float_mv", "market_cap", "total_market_cap"].includes(key)) {
    return { classification: "current_valuation_snapshot", riskLevel: "high", pointInTimeStatus: "must_be_ignored_or_historical" };
  }
  if (["theme", "physical_layers", "concepts", "concept_codes", "layer_count", "concept_count", "relevance", "reason", "source", "universe_source", "universesource"].includes(key)) {
    return { classification: "current_theme_snapshot", riskLevel: "high", pointInTimeStatus: "requires_point_in_time_snapshot" };
  }
  if (["industry", "industry_code", "申万行业", "sw_industry"].includes(key)) {
    return { classification: "current_industry_snapshot", riskLevel: "high", pointInTimeStatus: "requires_point_in_time_snapshot" };
  }
  return { classification: "unknown_or_review_required", riskLevel: "medium", pointInTimeStatus: "review_before_scoring" };
}

function auditUniverseFields(rows, options = {}) {
  const fieldSet = new Set();
  for (const row of rows || []) {
    for (const field of Object.keys(row || {})) fieldSet.add(field);
  }
  const fields = Array.from(fieldSet).sort().map((field) => {
    const key = String(field).toLowerCase();
    const rule = classifyUniverseField(field);
    const usedByScoring = SCORING_USED_UNIVERSE_FIELDS.has(key);
    let nonEmptyCount = 0;
    const examples = [];
    for (const row of rows || []) {
      const value = row?.[field];
      if (value == null || value === "") continue;
      nonEmptyCount += 1;
      if (examples.length < 3 && !examples.includes(String(value))) examples.push(String(value));
    }
    const requiresPointInTime = usedByScoring && rule.riskLevel === "high";
    const scoringAction = requiresPointInTime
      ? "replace_with_point_in_time_source_or_disable"
      : usedByScoring
        ? "used_by_scoring"
        : rule.riskLevel === "high"
          ? "ignored_by_scoring_but_keep_as_context_only"
          : "not_used_by_scoring";
    return {
      field,
      classification: rule.classification,
      riskLevel: rule.riskLevel,
      pointInTimeStatus: rule.pointInTimeStatus,
      usedByScoring,
      requiresPointInTime,
      scoringAction,
      nonEmptyCount,
      exampleValues: examples.join("|"),
    };
  });
  const usedHighRiskFields = fields
    .filter((field) => field.usedByScoring && field.riskLevel === "high")
    .map((field) => field.field);
  const ignoredHighRiskFields = fields
    .filter((field) => !field.usedByScoring && field.riskLevel === "high")
    .map((field) => field.field);
  const warning = usedHighRiskFields.length
    ? `Universe has scoring-used snapshot fields that need point-in-time sources: ${usedHighRiskFields.join(", ")}`
    : "No scoring-used high-risk snapshot fields detected; still verify universe membership point-in-time.";
  return {
    asOfRange: options.asOfRange || "",
    snapshotDate: options.snapshotDate || "",
    fields,
    summary: {
      fieldCount: fields.length,
      rowCount: Array.isArray(rows) ? rows.length : 0,
      usedHighRiskFields,
      ignoredHighRiskFields,
      mediumRiskFields: fields.filter((field) => field.riskLevel === "medium").map((field) => field.field),
      warning,
    },
  };
}

function marketSymbol(row) {
  const raw = String(row.code || row.SECURITY_CODE || "").trim();
  const market = row.market || row.MARKET || "";
  if (market === "港股通" || /港/.test(market) || /^\d{5}$/.test(raw)) return `hk${raw.padStart(5, "0")}`;
  const code = raw.padStart(6, "0");
  if (/^(6|688|689)/.test(code)) return `sh${code}`;
  if (/^(8|4|920|430|831|832|833|834|835|836|837|838|839|870|871|872|873|874)/.test(code)) return `bj${code}`;
  return `sz${code}`;
}

function sliceKline(kline, asOf, end) {
  const sorted = kline
    .filter((row) => row.date && Number.isFinite(Number(row.close)))
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  const history = sorted.filter((row) => row.date <= asOf);
  const future = sorted.filter((row) => row.date >= asOf && row.date <= end);
  return { history, future };
}

function retN(history, n) {
  if (history.length < 2) return null;
  const offset = Math.min(n, history.length - 1);
  const last = history[history.length - 1].close;
  const base = history[history.length - 1 - offset].close;
  return base > 0 ? (last / base) - 1 : null;
}

function avgTurnover(history, days = 20) {
  const rows = history.slice(-days);
  return mean(rows.map((row) => {
    const amount = Number(row.amount);
    if (Number.isFinite(amount) && amount > 0) return amount;
    return Number(row.close) * Number(row.volume || 0);
  }));
}

function maxDrawdown(history, days = 60) {
  const rows = history.slice(-days);
  if (!rows.length) return null;
  const last = rows[rows.length - 1].close;
  const high = Math.max(...rows.map((row) => row.high ?? row.close));
  return high > 0 ? (last / high) - 1 : null;
}

function realizedVol(history, days = 20) {
  const rows = history.slice(-(days + 1));
  const daily = [];
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1].close;
    if (prev > 0) daily.push((rows[i].close / prev) - 1);
  }
  return daily.length ? stddev(daily) * Math.sqrt(252) : null;
}

function lotterySpikeMetrics(history, days = 20) {
  const rows = history.slice(-(days + 1));
  const dailyReturns = [];
  for (let i = 1; i < rows.length; i += 1) {
    const prev = Number(rows[i - 1].close);
    const close = Number(rows[i].close);
    if (prev > 0 && Number.isFinite(close)) {
      dailyReturns.push((close / prev) - 1);
    }
  }
  if (!dailyReturns.length) {
    return {
      maxDailyReturn20: null,
      lotterySpikeScore: 50,
    };
  }
  const maxDailyReturn20 = Math.max(...dailyReturns);
  const positiveReturns = dailyReturns.filter((value) => value > 0);
  const positiveReturnSum = positiveReturns.reduce((sum, value) => sum + value, 0);
  const maxPositiveShare20 = positiveReturnSum > 0 ? Math.max(0, maxDailyReturn20) / positiveReturnSum : 0;
  const spikePenalty =
    clamp((maxDailyReturn20 - 0.08) / 0.16, 0, 1) * 62 +
    clamp((maxPositiveShare20 - 0.45) / 0.35, 0, 1) * 38;
  return {
    maxDailyReturn20,
    maxPositiveShare20,
    lotterySpikeScore: clamp(100 - spikePenalty),
  };
}

function themeScore(row, options = {}) {
  if (options.staticThemeScore === false) return 50;
  const concepts = String(row.concepts || "").split("|").filter(Boolean).length;
  let score = 55;
  if (String(row.relevance || "").includes("核心")) score += 18;
  if (String(row.source || "").includes("manual")) score += 8;
  score += Math.min(14, concepts * 2);
  if (row.market === "北交所/新三板系") score -= 4;
  return clamp(score);
}

function scaleLog(value, low, high) {
  if (!Number.isFinite(value) || value <= 0) return 40;
  const x = Math.log(value);
  const a = Math.log(low);
  const b = Math.log(high);
  return clamp(((x - a) / (b - a)) * 80 + 10);
}

function finite01(value, fallback = 0.5) {
  return Number.isFinite(value) ? clamp(value, 0, 1) : fallback;
}

function rankByField(rows, field, options = {}) {
  const lowerBetter = Boolean(options.lowerBetter);
  const values = rows
    .map((row) => Number(row[field]))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  const out = new Map();
  if (!values.length) {
    for (const row of rows) out.set(row, 0.5);
    return out;
  }
  const denom = values.length > 1 ? values.length - 1 : 1;
  for (const row of rows) {
    const value = Number(row[field]);
    if (!Number.isFinite(value)) {
      out.set(row, 0.5);
      continue;
    }
    let first = values.findIndex((candidate) => candidate === value);
    if (first < 0) first = 0;
    let last = first;
    while (last + 1 < values.length && values[last + 1] === value) last += 1;
    const percentile = values.length > 1 ? ((first + last) / 2) / denom : 0.5;
    out.set(row, lowerBetter ? 1 - percentile : percentile);
  }
  return out;
}

function consistencyScore(row) {
  const windows = [row.r5, row.r20, row.r60].filter((value) => Number.isFinite(value));
  if (!windows.length) return 0.5;
  const positiveRatio = mean(windows.map((value) => (value > 0 ? 1 : 0))) ?? 0.5;
  const trendShape =
    Number.isFinite(row.r20) && Number.isFinite(row.r60) && row.r20 > 0 && row.r60 > 0 && row.r20 <= row.r60 * 1.5
      ? 0.2
      : 0;
  return clamp((positiveRatio + trendShape) * 100) / 100;
}

function overheatPenalty(row) {
  const r5Penalty = Number.isFinite(row.r5) ? clamp((row.r5 - 0.12) / 0.18, 0, 1) : 0;
  const r20Penalty = Number.isFinite(row.r20) ? clamp((row.r20 - 0.35) / 0.35, 0, 1) : 0;
  const volPenalty = Number.isFinite(row.vol20) ? clamp((row.vol20 - 1.15) / 0.75, 0, 1) : 0;
  return clamp(r5Penalty * 0.45 + r20Penalty * 0.35 + volPenalty * 0.20, 0, 1);
}

function avgRowTurnover(rows) {
  return mean(rows.map((row) => rowTurnover(row)));
}

function pullbackAccumulationMetrics(history, returns = {}) {
  const rows20 = history.slice(-20);
  const recent5 = history.slice(-5);
  const prior15 = history.slice(-20, -5);
  const last = history[history.length - 1];
  const close = Number(last?.close);
  const high20 = rows20.length ? Math.max(...rows20.map((row) => Number(row.high ?? row.close)).filter(Number.isFinite)) : null;
  const avgClose20 = mean(rows20.map((row) => Number(row.close)));
  const recentTurnover5 = avgRowTurnover(recent5);
  const priorTurnover15 = avgRowTurnover(prior15);
  const pullbackVolumeRatio5v20 =
    Number.isFinite(recentTurnover5) && Number.isFinite(priorTurnover15) && priorTurnover15 > 0
      ? recentTurnover5 / priorTurnover15
      : null;
  const pullbackDrawdown20 = Number.isFinite(close) && Number.isFinite(high20) && high20 > 0 ? close / high20 - 1 : null;
  const supportRatio20 = Number.isFinite(close) && Number.isFinite(avgClose20) && avgClose20 > 0 ? close / avgClose20 - 1 : null;
  const r5 = returns.r5;
  const r20 = returns.r20;
  const r60 = returns.r60;

  const trendScore = clamp(
    finite01(Number.isFinite(r20) ? (r20 - 0.04) / 0.18 : null, 0.45) * 0.72 +
      finite01(Number.isFinite(r60) ? (r60 - 0.06) / 0.32 : null, 0.45) * 0.28,
    0,
    1
  );
  const pullbackDepth = Number.isFinite(pullbackDrawdown20) ? -pullbackDrawdown20 : null;
  const depthScore = Number.isFinite(pullbackDepth)
    ? clamp(1 - Math.abs(pullbackDepth - 0.045) / 0.075, 0, 1)
    : 0.45;
  const recentReturnScore = Number.isFinite(r5)
    ? clamp(1 - Math.abs(r5 + 0.02) / 0.09, 0, 1)
    : 0.45;
  const supportScore = Number.isFinite(supportRatio20)
    ? clamp((supportRatio20 + 0.02) / 0.10, 0, 1)
    : 0.45;
  const volumeScore = Number.isFinite(pullbackVolumeRatio5v20)
    ? pullbackVolumeRatio5v20 <= 0.85
      ? clamp((pullbackVolumeRatio5v20 - 0.25) / 0.30, 0.35, 1)
      : clamp(1 - (pullbackVolumeRatio5v20 - 0.85) / 0.75, 0, 1)
    : 0.45;
  const heatPenalty =
    (Number.isFinite(r5) ? clamp((r5 - 0.08) / 0.12, 0, 1) * 0.55 : 0) +
    (Number.isFinite(pullbackDepth) ? clamp((0.012 - pullbackDepth) / 0.012, 0, 1) * 0.20 : 0) +
    (Number.isFinite(pullbackDepth) ? clamp((pullbackDepth - 0.14) / 0.12, 0, 1) * 0.25 : 0);

  const score = clamp(
    (trendScore * 0.30 + depthScore * 0.22 + recentReturnScore * 0.18 + supportScore * 0.15 + volumeScore * 0.15) * 100 -
      heatPenalty * 35
  );

  return {
    pullbackAccumulationScore: Number(score.toFixed(4)),
    pullbackDrawdown20,
    pullbackSupportRatio20: supportRatio20,
    pullbackVolumeRatio5v20,
  };
}

function volumeMomentumMetrics(history, returns = {}) {
  const recent5 = history.slice(-5);
  const prior15 = history.slice(-20, -5);
  const recentTurnover5 = avgRowTurnover(recent5);
  const priorTurnover15 = avgRowTurnover(prior15);
  const volumeTurnoverRatio5v20 =
    Number.isFinite(recentTurnover5) && Number.isFinite(priorTurnover15) && priorTurnover15 > 0
      ? recentTurnover5 / priorTurnover15
      : null;
  const r5 = returns.r5;
  const r20 = returns.r20;
  const acceleration20vs60 = returns.acceleration20vs60;
  const trendScore = clamp(
    finite01(Number.isFinite(r20) ? (r20 - 0.04) / 0.20 : null, 0.45) * 0.62 +
      finite01(Number.isFinite(acceleration20vs60) ? (acceleration20vs60 + 0.02) / 0.16 : null, 0.45) * 0.38,
    0,
    1
  );
  const volumeScore = Number.isFinite(volumeTurnoverRatio5v20)
    ? volumeTurnoverRatio5v20 < 1
      ? clamp((volumeTurnoverRatio5v20 - 0.55) / 0.55, 0, 1)
      : volumeTurnoverRatio5v20 <= 2.2
        ? clamp((volumeTurnoverRatio5v20 - 0.85) / 0.65, 0.35, 1)
        : clamp(1 - (volumeTurnoverRatio5v20 - 2.2) / 2.3, 0, 1)
    : 0.45;
  const shortTermScore = Number.isFinite(r5)
    ? r5 < 0
      ? clamp((r5 + 0.05) / 0.05, 0, 0.45)
      : r5 <= 0.12
        ? clamp((r5 - 0.01) / 0.07, 0.35, 1)
        : clamp(1 - (r5 - 0.12) / 0.18, 0, 1)
    : 0.45;
  const frenzyPenalty =
    (Number.isFinite(r5) ? clamp((r5 - 0.18) / 0.18, 0, 1) * 0.55 : 0) +
    (Number.isFinite(volumeTurnoverRatio5v20) ? clamp((volumeTurnoverRatio5v20 - 3.0) / 2.5, 0, 1) * 0.45 : 0);
  const score = clamp((trendScore * 0.34 + volumeScore * 0.38 + shortTermScore * 0.28) * 100 - frenzyPenalty * 35);
  return {
    volumeMomentumScore: Number(score.toFixed(4)),
    volumeTurnoverRatio5v20,
  };
}

function turnoverStabilityMetrics(history) {
  const rows20 = history.slice(-20);
  const turnovers = rows20
    .map((row) => rowTurnover(row))
    .filter((value) => Number.isFinite(value) && value > 0);
  const avg = mean(turnovers);
  const turnoverCv20 = Number.isFinite(avg) && avg > 0 ? stddev(turnovers) / avg : null;
  const turnoverStabilityScore = Number.isFinite(turnoverCv20)
    ? clamp(100 - turnoverCv20 * 85)
    : 50;
  return {
    turnoverCv20,
    turnoverStabilityScore: Number(turnoverStabilityScore.toFixed(4)),
  };
}

function shortTermReversalMetrics(history, returns = {}) {
  const rows20 = history.slice(-20);
  const last = history[history.length - 1];
  const close = Number(last?.close);
  const high20 = rows20.length ? Math.max(...rows20.map((row) => Number(row.high ?? row.close)).filter(Number.isFinite)) : null;
  const avgClose20 = mean(rows20.map((row) => Number(row.close)));
  const shortTermDrawdown20 = Number.isFinite(close) && Number.isFinite(high20) && high20 > 0 ? close / high20 - 1 : null;
  const shortTermSupportRatio20 = Number.isFinite(close) && Number.isFinite(avgClose20) && avgClose20 > 0 ? close / avgClose20 - 1 : null;
  const r3 = retN(history, 3);
  const r5 = returns.r5;
  const r20 = returns.r20;
  const r60 = returns.r60;
  const vol20 = returns.vol20;
  const turnover = turnoverStabilityMetrics(history);

  const trendScore = clamp(
    finite01(Number.isFinite(r20) ? (r20 - 0.03) / 0.20 : null, 0.45) * 0.65 +
      finite01(Number.isFinite(r60) ? (r60 - 0.05) / 0.34 : null, 0.45) * 0.35,
    0,
    1
  );
  const r3CoolingScore = Number.isFinite(r3)
    ? clamp(1 - Math.abs(r3 + 0.015) / 0.075, 0, 1)
    : 0.45;
  const r5CoolingScore = Number.isFinite(r5)
    ? r5 <= 0.02
      ? clamp(1 - Math.abs(r5 + 0.015) / 0.08, 0, 1)
      : clamp(1 - (r5 - 0.02) / 0.16, 0, 0.65)
    : 0.45;
  const pullbackDepth = Number.isFinite(shortTermDrawdown20) ? -shortTermDrawdown20 : null;
  const pullbackScore = Number.isFinite(pullbackDepth)
    ? clamp(1 - Math.abs(pullbackDepth - 0.04) / 0.095, 0, 1)
    : 0.45;
  const supportScore = Number.isFinite(shortTermSupportRatio20)
    ? shortTermSupportRatio20 >= 0.05
      ? clamp(1 - (shortTermSupportRatio20 - 0.05) / 0.16, 0.25, 1)
      : clamp((shortTermSupportRatio20 + 0.08) / 0.13, 0, 1)
    : 0.45;
  const volatilityScore = Number.isFinite(vol20)
    ? clamp(1 - Math.abs(vol20 - 0.45) / 0.80, 0, 1)
    : 0.50;
  const turnoverScore = clamp(turnover.turnoverStabilityScore) / 100;
  const heatPenalty =
    (Number.isFinite(r3) ? clamp((r3 - 0.06) / 0.11, 0, 1) * 0.35 : 0) +
    (Number.isFinite(r5) ? clamp((r5 - 0.12) / 0.18, 0, 1) * 0.35 : 0) +
    (Number.isFinite(vol20) ? clamp((vol20 - 1.1) / 0.8, 0, 1) * 0.30 : 0);
  const score = clamp(
    (trendScore * 0.22 +
      r3CoolingScore * 0.18 +
      r5CoolingScore * 0.12 +
      pullbackScore * 0.16 +
      supportScore * 0.10 +
      turnoverScore * 0.12 +
      volatilityScore * 0.10) *
      100 -
      heatPenalty * 35
  );

  return {
    shortTermReversalScore: Number(score.toFixed(4)),
    shortTermReversalR3: r3,
    shortTermDrawdown20,
    shortTermSupportRatio20,
    turnoverCv20: turnover.turnoverCv20,
    turnoverStabilityScore: turnover.turnoverStabilityScore,
  };
}

function freshTrendMetrics(history, returns = {}) {
  const r5 = returns.r5;
  const r20 = returns.r20;
  const r60 = returns.r60;
  const acceleration20vs60 = returns.acceleration20vs60;
  const freshAccelerationScore = Number.isFinite(acceleration20vs60)
    ? clamp((acceleration20vs60 + 0.03) / 0.20 * 100)
    : 50;
  const constructiveR20Score = Number.isFinite(r20)
    ? r20 < -0.04
      ? clamp((r20 + 0.12) / 0.08 * 45)
      : r20 <= 0.24
        ? clamp((r20 + 0.02) / 0.22 * 100)
        : clamp(100 - (r20 - 0.24) / 0.28 * 42)
    : 50;
  const shortSlopeScore = Number.isFinite(r5)
    ? r5 < -0.05
      ? clamp((r5 + 0.12) / 0.07 * 45)
      : r5 <= 0.12
        ? clamp((r5 + 0.03) / 0.15 * 100)
        : clamp(100 - (r5 - 0.12) / 0.18 * 55)
    : 50;
  const staleR60Penalty = Number.isFinite(r60) ? clamp((r60 - 0.28) / 0.46 * 100) : 0;
  const decelerationPenalty =
    Number.isFinite(acceleration20vs60) && Number.isFinite(r60) && r60 > 0.24
      ? clamp((-acceleration20vs60) / 0.20 * 100)
      : 0;
  const overheatR20Penalty = Number.isFinite(r20) ? clamp((r20 - 0.36) / 0.32 * 100) : 0;
  const trendMaturityPenaltyScore = clamp(
    staleR60Penalty * 0.42 +
      decelerationPenalty * 0.43 +
      overheatR20Penalty * 0.15
  );
  const freshTrendScore = clamp(
    freshAccelerationScore * 0.42 +
      constructiveR20Score * 0.26 +
      shortSlopeScore * 0.17 +
      (100 - trendMaturityPenaltyScore) * 0.15 -
      trendMaturityPenaltyScore * 0.10
  );

  return {
    freshTrendScore: Number(freshTrendScore.toFixed(4)),
    freshAccelerationScore: Number(freshAccelerationScore.toFixed(4)),
    trendMaturityPenaltyScore: Number(trendMaturityPenaltyScore.toFixed(4)),
  };
}

function high52wMomentumMetrics(history, returns = {}) {
  const rows = history.slice(-252);
  const last = rows[rows.length - 1];
  const lastClose = Number(last?.close);
  let high = null;
  let highIndex = -1;
  for (let i = 0; i < rows.length; i += 1) {
    const rowHigh = Number(rows[i].high ?? rows[i].close);
    if (!Number.isFinite(rowHigh) || rowHigh <= 0) continue;
    if (high == null || rowHigh >= high) {
      high = rowHigh;
      highIndex = i;
    }
  }
  const high52wDistance = Number.isFinite(lastClose) && Number.isFinite(high) && high > 0 ? (lastClose / high) - 1 : null;
  const high52wDaysSinceHigh = highIndex >= 0 ? rows.length - 1 - highIndex : null;
  const proximityScore = Number.isFinite(high52wDistance)
    ? clamp((high52wDistance + 0.30) / 0.30 * 100)
    : 50;
  const recencyScore = Number.isFinite(high52wDaysSinceHigh)
    ? clamp(100 - (high52wDaysSinceHigh / 252) * 85)
    : 50;
  const r20Score = Number.isFinite(returns.r20)
    ? clamp((returns.r20 + 0.04) / 0.24 * 100)
    : 50;
  const r60Score = Number.isFinite(returns.r60)
    ? clamp((returns.r60 + 0.06) / 0.40 * 100)
    : 50;
  const notOverextendedScore = Number.isFinite(high52wDistance)
    ? high52wDistance > -0.006
      ? 82
      : clamp(100 - Math.abs(high52wDistance + 0.035) / 0.16 * 70)
    : 50;
  const score = clamp(
    proximityScore * 0.36 +
      recencyScore * 0.18 +
      r20Score * 0.18 +
      r60Score * 0.18 +
      notOverextendedScore * 0.10
  );
  return {
    high52wScore: Number(score.toFixed(4)),
    high52wDistance,
    high52wDaysSinceHigh,
  };
}

function applyCrossSectionalRankScore(rows, params = {}) {
  if (!rows.length) return rows;
  const ranks = {
    r5: rankByField(rows, "r5"),
    r20: rankByField(rows, "r20"),
    r60: rankByField(rows, "r60"),
    acceleration20vs60: rankByField(rows, "acceleration20vs60"),
    relativeR20: rankByField(rows, "relativeR20"),
    relativeR60: rankByField(rows, "relativeR60"),
    relativeMomentumScore: rankByField(rows, "relativeMomentumScore"),
    benchmarkR60: rankByField(rows, "benchmarkR60"),
    dd60: rankByField(rows, "dd60"),
    vol20: rankByField(rows, "vol20", { lowerBetter: true }),
    avgTurnover20: rankByField(rows, "avgTurnover20"),
    themeScore: rankByField(rows, "themeScore"),
    industryMomentumScore: rankByField(rows, "industryMomentumScore"),
    industryResidualMomentumScore: rankByField(rows, "industryResidualMomentumScore"),
    dynamicGroupScore: rankByField(rows, "dynamicGroupScore"),
    pullbackAccumulationScore: rankByField(rows, "pullbackAccumulationScore"),
    volumeMomentumScore: rankByField(rows, "volumeMomentumScore"),
    high52wScore: rankByField(rows, "high52wScore"),
    shortTermReversalScore: rankByField(rows, "shortTermReversalScore"),
    turnoverStabilityScore: rankByField(rows, "turnoverStabilityScore"),
    freshTrendScore: rankByField(rows, "freshTrendScore"),
    lotterySpikeScore: rankByField(rows, "lotterySpikeScore"),
  };
  const weights = {
    momentum: params.rankMomentumWeight ?? 0.42,
    stability: params.rankStabilityWeight ?? 0.24,
    liquidity: params.rankLiquidityWeight ?? 0.16,
    theme: params.rankThemeWeight ?? 0.10,
    consistency: params.rankConsistencyWeight ?? 0.08,
    relative: params.rankRelativeWeight ?? 0,
    industry: params.rankIndustryWeight ?? 0,
    industryResidual: params.rankIndustryResidualWeight ?? 0,
    dynamicGroup: params.rankDynamicGroupWeight ?? 0,
    acceleration: params.rankAccelerationWeight ?? 0,
    pullback: params.rankPullbackWeight ?? 0,
    volumeMomentum: params.rankVolumeMomentumWeight ?? 0,
    high52w: params.rankHigh52wWeight ?? 0,
    shortTermReversal: params.rankShortTermReversalWeight ?? 0,
    turnoverStability: params.rankTurnoverStabilityWeight ?? 0,
    freshTrend: params.rankFreshTrendWeight ?? 0,
    lotterySpike: params.rankLotterySpikeWeight ?? 0,
    benchmarkTrend: params.rankBenchmarkTrendWeight ?? 0,
    relativeMomentum: params.rankRelativeMomentumWeight ?? 0,
  };
  const totalWeight = Object.values(weights).reduce((sum, value) => sum + value, 0) || 1;
  const rawScoreWeight = params.rankRawScoreWeight ?? 0.12;
  const penaltyWeight = params.rankOverheatPenalty ?? 8;

  for (const row of rows) {
    const trendRank =
      finite01(ranks.r60.get(row)) * 0.38 +
      finite01(ranks.r20.get(row)) * 0.38 +
      finite01(ranks.r5.get(row)) * 0.12 +
      finite01(ranks.dd60.get(row)) * 0.12;
    const stabilityRank = finite01(ranks.vol20.get(row)) * 0.58 + finite01(ranks.dd60.get(row)) * 0.42;
    const liquidityRank = finite01(ranks.avgTurnover20.get(row));
    const themeRank = finite01(ranks.themeScore.get(row));
    const relativeRank = finite01(ranks.relativeR60.get(row)) * 0.55 + finite01(ranks.relativeR20.get(row)) * 0.45;
    const relativeMomentumRank = finite01(ranks.relativeMomentumScore.get(row));
    const benchmarkTrendRank = finite01(ranks.benchmarkR60.get(row));
    const industryRank = finite01(ranks.industryMomentumScore.get(row));
    const industryResidualRank = finite01(ranks.industryResidualMomentumScore.get(row));
    const dynamicGroupRank = finite01(ranks.dynamicGroupScore.get(row));
    const accelerationRank = finite01(ranks.acceleration20vs60.get(row));
    const pullbackRank = finite01(ranks.pullbackAccumulationScore.get(row));
    const volumeMomentumRank = finite01(ranks.volumeMomentumScore.get(row));
    const high52wRank = finite01(ranks.high52wScore.get(row));
    const shortTermReversalRank = finite01(ranks.shortTermReversalScore.get(row));
    const turnoverStabilityRank = finite01(ranks.turnoverStabilityScore.get(row));
    const freshTrendRank = finite01(ranks.freshTrendScore.get(row));
    const lotterySpikeRank = finite01(ranks.lotterySpikeScore.get(row));
    const consistent = consistencyScore(row);
    const factorScore = (
      trendRank * weights.momentum +
      stabilityRank * weights.stability +
      liquidityRank * weights.liquidity +
      themeRank * weights.theme +
      consistent * weights.consistency +
      relativeRank * weights.relative +
      industryRank * weights.industry +
      industryResidualRank * weights.industryResidual +
      dynamicGroupRank * weights.dynamicGroup +
      accelerationRank * weights.acceleration +
      pullbackRank * weights.pullback +
      volumeMomentumRank * weights.volumeMomentum +
      high52wRank * weights.high52w +
      shortTermReversalRank * weights.shortTermReversal +
      turnoverStabilityRank * weights.turnoverStability +
      freshTrendRank * weights.freshTrend +
      lotterySpikeRank * weights.lotterySpike +
      benchmarkTrendRank * weights.benchmarkTrend +
      relativeMomentumRank * weights.relativeMomentum
    ) / totalWeight;
    const rawNormalized = clamp(row.score ?? 50) / 100;
    const heatPenalty = overheatPenalty(row);
    const finalScore = clamp(
      (factorScore * (1 - rawScoreWeight) + rawNormalized * rawScoreWeight) * 100 - heatPenalty * penaltyWeight
    );

    row.rawScore = row.score;
    row.crossSectionScore = Number((factorScore * 100).toFixed(4));
    row.trendRankScore = Number((trendRank * 100).toFixed(4));
    row.riskRankScore = Number((stabilityRank * 100).toFixed(4));
    row.liquidityRankScore = Number((liquidityRank * 100).toFixed(4));
    row.themeRankScore = Number((themeRank * 100).toFixed(4));
    row.relativeRankScore = Number((relativeRank * 100).toFixed(4));
    row.relativeMomentumRankScore = Number((relativeMomentumRank * 100).toFixed(4));
    row.benchmarkTrendRankScore = Number((benchmarkTrendRank * 100).toFixed(4));
    row.industryRankScore = Number((industryRank * 100).toFixed(4));
    row.industryResidualRankScore = Number((industryResidualRank * 100).toFixed(4));
    row.dynamicGroupRankScore = Number((dynamicGroupRank * 100).toFixed(4));
    row.accelerationRankScore = Number((accelerationRank * 100).toFixed(4));
    row.pullbackRankScore = Number((pullbackRank * 100).toFixed(4));
    row.volumeMomentumRankScore = Number((volumeMomentumRank * 100).toFixed(4));
    row.high52wRankScore = Number((high52wRank * 100).toFixed(4));
    row.shortTermReversalRankScore = Number((shortTermReversalRank * 100).toFixed(4));
    row.turnoverStabilityRankScore = Number((turnoverStabilityRank * 100).toFixed(4));
    row.freshTrendRankScore = Number((freshTrendRank * 100).toFixed(4));
    row.lotterySpikeRankScore = Number((lotterySpikeRank * 100).toFixed(4));
    row.consistencyRankScore = Number((consistent * 100).toFixed(4));
    row.overheatPenaltyScore = Number((heatPenalty * penaltyWeight).toFixed(4));
    row.score = Number(finalScore.toFixed(4));
  }
  return rows;
}

function applyIndustryMomentumMetrics(rows, params = {}) {
  if (params.staticIndustryMomentum === false) return rows;
  const minGroupSize = params.industryMinGroupSize ?? 3;
  const groups = new Map();
  for (const row of rows) {
    const industry = String(row.industry || "").trim();
    if (!industry) continue;
    if (!groups.has(industry)) groups.set(industry, []);
    groups.get(industry).push(row);
  }
  const stats = new Map();
  for (const [industry, members] of groups.entries()) {
    if (members.length < minGroupSize) continue;
    const r20 = mean(members.map((row) => row.r20));
    const r60 = mean(members.map((row) => row.r60));
    const rel20 = mean(members.map((row) => row.relativeR20));
    const rel60 = mean(members.map((row) => row.relativeR60));
    const breadth20 = mean(members.map((row) => (Number(row.r20) > 0 ? 1 : 0)));
    let score = 50;
    score += clamp((r20 ?? 0) * 90, -18, 24);
    score += clamp((r60 ?? 0) * 45, -14, 20);
    score += clamp((rel20 ?? 0) * 80, -16, 22);
    score += clamp((rel60 ?? 0) * 40, -12, 18);
    score += clamp(((breadth20 ?? 0.5) - 0.5) * 30, -10, 10);
    stats.set(industry, {
      industry,
      industryCount: members.length,
      industryR20: r20,
      industryR60: r60,
      industryRelativeR20: rel20,
      industryRelativeR60: rel60,
      industryBreadth20: breadth20,
      industryMomentumScore: clamp(score),
    });
  }
  for (const row of rows) {
    const stat = stats.get(String(row.industry || "").trim());
    if (!stat) continue;
    const industryResidualR20 = Number.isFinite(row.r20) && Number.isFinite(stat.industryR20) ? row.r20 - stat.industryR20 : null;
    const industryResidualR60 = Number.isFinite(row.r60) && Number.isFinite(stat.industryR60) ? row.r60 - stat.industryR60 : null;
    const industryResidualRelativeR20 =
      Number.isFinite(row.relativeR20) && Number.isFinite(stat.industryRelativeR20) ? row.relativeR20 - stat.industryRelativeR20 : null;
    const industryResidualRelativeR60 =
      Number.isFinite(row.relativeR60) && Number.isFinite(stat.industryRelativeR60) ? row.relativeR60 - stat.industryRelativeR60 : null;
    let residualMomentumScore = 50;
    residualMomentumScore += clamp((industryResidualR20 ?? 0) * 180, -26, 30);
    residualMomentumScore += clamp((industryResidualR60 ?? 0) * 90, -18, 24);
    residualMomentumScore += clamp((industryResidualRelativeR20 ?? 0) * 130, -16, 20);
    residualMomentumScore += clamp((industryResidualRelativeR60 ?? 0) * 65, -10, 16);
    row.industryCount = stat.industryCount;
    row.industryR20 = stat.industryR20;
    row.industryR60 = stat.industryR60;
    row.industryRelativeR20 = stat.industryRelativeR20;
    row.industryRelativeR60 = stat.industryRelativeR60;
    row.industryBreadth20 = stat.industryBreadth20;
    row.industryMomentumScore = stat.industryMomentumScore;
    row.industryResidualR20 = industryResidualR20;
    row.industryResidualR60 = industryResidualR60;
    row.industryResidualRelativeR20 = industryResidualRelativeR20;
    row.industryResidualRelativeR60 = industryResidualRelativeR60;
    row.industryResidualMomentumScore = clamp(residualMomentumScore);
  }
  return rows;
}

function splitConcepts(value) {
  return String(value || "")
    .split(/[|,，、;；]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function dynamicGroupKeys(row, options = {}) {
  const groupBy = String(options.groupBy || "industry").toLowerCase();
  const keys = [];
  if (groupBy === "industry" || groupBy === "both") {
    const industry = String(row.industry || "").trim();
    if (industry) keys.push(`industry:${industry}`);
  }
  if (groupBy === "concept" || groupBy === "concepts" || groupBy === "both") {
    for (const concept of splitConcepts(row.concepts)) {
      keys.push(`concept:${concept}`);
    }
  }
  if (groupBy === "source" || groupBy === "sources" || groupBy === "universe" || groupBy === "universe_source") {
    for (const source of splitConcepts(row.universeSource || row.source)) {
      keys.push(`source:${source}`);
    }
  }
  return Array.from(new Set(keys));
}

function dynamicGroupStats(rows, options = {}) {
  const minGroupSize = options.minGroupSize ?? 8;
  const groups = new Map();
  for (const row of rows) {
    for (const key of dynamicGroupKeys(row, options)) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
  }

  const stats = new Map();
  for (const [key, members] of groups.entries()) {
    if (members.length < minGroupSize) continue;
    const r20 = mean(members.map((row) => row.r20));
    const r60 = mean(members.map((row) => row.r60));
    const rel20 = mean(members.map((row) => row.relativeR20));
    const rel60 = mean(members.map((row) => row.relativeR60));
    const breadth20 = mean(members.map((row) => (Number(row.r20) > 0 ? 1 : 0)));
    let score = 50;
    score += clamp((r20 ?? 0) * 90, -18, 24);
    score += clamp((r60 ?? 0) * 45, -14, 20);
    score += clamp((rel20 ?? 0) * 80, -16, 22);
    score += clamp((rel60 ?? 0) * 40, -12, 18);
    score += clamp(((breadth20 ?? 0.5) - 0.5) * 30, -10, 10);
    stats.set(key, {
      dynamicGroupKey: key,
      dynamicGroupCount: members.length,
      dynamicGroupR20: r20,
      dynamicGroupR60: r60,
      dynamicGroupRelativeR20: rel20,
      dynamicGroupRelativeR60: rel60,
      dynamicGroupBreadth20: breadth20,
      dynamicGroupScore: clamp(score),
    });
  }
  return stats;
}

function bestDynamicGroupStat(row, stats, options = {}) {
  const candidates = dynamicGroupKeys(row, options)
    .map((key) => stats.get(key))
    .filter(Boolean)
    .sort((a, b) => b.dynamicGroupScore - a.dynamicGroupScore);
  return candidates[0] || null;
}

function applyDynamicGroupMetrics(rows, options = {}) {
  if (!options.enabled) return rows;
  const stats = dynamicGroupStats(rows, options);
  const scoreWeight = Number.isFinite(Number(options.scoreWeight))
    ? Math.min(1, Math.max(0, Number(options.scoreWeight)))
    : 0;
  for (const row of rows) {
    const stat = bestDynamicGroupStat(row, stats, options);
    if (!stat) continue;
    Object.assign(row, stat);
    if (scoreWeight > 0 && Number.isFinite(Number(row.score)) && Number.isFinite(Number(stat.dynamicGroupScore))) {
      row.scoreBeforeDynamicGroupBlend = row.score;
      row.dynamicGroupScoreBlendWeight = scoreWeight;
      row.score = Number(clamp(row.score * (1 - scoreWeight) + stat.dynamicGroupScore * scoreWeight).toFixed(4));
    }
  }
  return rows;
}

function applyDynamicGroupUniverseFilter(rows, skipped, options = {}) {
  if (!options.enabled) return rows;
  const stats = dynamicGroupStats(rows, options);
  const minGroupScore = options.minGroupScore ?? 55;
  const minBreadth20 = options.minBreadth20 ?? 0.45;
  const minRemainingCount = options.minRemainingCount ?? 0;
  const minRemainingRatio = Number.isFinite(Number(options.minRemainingRatio))
    ? Math.min(1, Math.max(0, Number(options.minRemainingRatio)))
    : 0;
  const keepUngrouped = Boolean(options.keepUngrouped);
  const kept = [];
  const rejected = [];
  for (const row of rows) {
    const stat = bestDynamicGroupStat(row, stats, options);
    if (!stat) {
      if (keepUngrouped) {
        kept.push(row);
        continue;
      }
      rejected.push({
        code: row.code,
        name: row.name,
        reason: "universe_missing_dynamic_group",
        historyDays: row.historyDays,
        dynamicGroupKey: dynamicGroupKeys(row, options).join("|"),
      });
      continue;
    }

    const eligible =
      stat.dynamicGroupScore >= minGroupScore &&
      stat.dynamicGroupBreadth20 >= minBreadth20;
    if (!eligible) {
      rejected.push({
        code: row.code,
        name: row.name,
        reason: "universe_weak_dynamic_group",
        historyDays: row.historyDays,
        ...stat,
      });
      continue;
    }

    Object.assign(row, stat);
    kept.push(row);
  }
  const minRemainingByRatio = minRemainingRatio > 0 ? Math.ceil(rows.length * minRemainingRatio) : 0;
  const minRemaining = Math.max(minRemainingCount, minRemainingByRatio);
  if (minRemaining > 0 && kept.length < minRemaining) {
    return rows;
  }
  skipped.push(...rejected);
  return kept;
}

function applyBenchmarkRelativeMetrics(score, benchmarkKline, asOf, params = {}) {
  if (!benchmarkKline?.length) return score;
  const { history } = sliceKline(benchmarkKline, asOf, asOf);
  if (history.length < 2) return score;
  const benchmarkR20 = retN(history, 20);
  const benchmarkR60 = retN(history, 60);
  const benchmarkR5 = retN(history, 5);
  const relativeR20 = Number.isFinite(score.r20) && Number.isFinite(benchmarkR20) ? score.r20 - benchmarkR20 : null;
  const relativeR60 = Number.isFinite(score.r60) && Number.isFinite(benchmarkR60) ? score.r60 - benchmarkR60 : null;
  const relativeR5 = Number.isFinite(score.r5) && Number.isFinite(benchmarkR5) ? score.r5 - benchmarkR5 : null;
  let relativeMomentumScore = 50;
  relativeMomentumScore += clamp((relativeR20 ?? 0) * 120, -22, 28);
  relativeMomentumScore += clamp((relativeR60 ?? 0) * 70, -18, 24);
  relativeMomentumScore += clamp((relativeR5 ?? 0) * 60, -8, 10);
  score.benchmarkR5 = benchmarkR5;
  score.benchmarkR20 = benchmarkR20;
  score.benchmarkR60 = benchmarkR60;
  score.relativeR5 = relativeR5;
  score.relativeR20 = relativeR20;
  score.relativeR60 = relativeR60;
  score.relativeMomentumScore = clamp(relativeMomentumScore);
  if (params.relativeScoreWeight && !params.rankBlend) {
    score.rawScore = score.score;
    score.score = Number(clamp(score.score * (1 - params.relativeScoreWeight) + score.relativeMomentumScore * params.relativeScoreWeight).toFixed(4));
  }
  return score;
}

function scoreAtDate(row, kline, asOf, params = defaultParams()) {
  const { history } = sliceKline(kline, asOf, asOf);
  const minHistoryDays = params.minHistoryDays ?? 4;
  if (history.length < minHistoryDays) {
    return {
      code: row.code,
      name: row.name,
      score: 0,
      status: "skipped",
      reason: `history_less_than_${minHistoryDays}_days`,
      historyDays: history.length,
    };
  }
  const r5 = retN(history, 5);
  const r20 = retN(history, 20);
  const r60 = retN(history, 60);
  const acceleration20vs60 = Number.isFinite(r20) && Number.isFinite(r60) ? r20 - (r60 / 3) : null;
  const dd60 = maxDrawdown(history, 60);
  const vol20 = realizedVol(history, 20);
  const turnover = avgTurnover(history, 20);
  const pullback = pullbackAccumulationMetrics(history, { r5, r20, r60 });
  const volumeMomentum = volumeMomentumMetrics(history, { r5, r20, acceleration20vs60 });
  const reversalStability = shortTermReversalMetrics(history, { r5, r20, r60, vol20 });
  const freshTrend = freshTrendMetrics(history, { r5, r20, r60, acceleration20vs60 });
  const high52w = high52wMomentumMetrics(history, { r20, r60 });
  const lotterySpike = lotterySpikeMetrics(history, 20);

  let momentum = 50;
  momentum += clamp((r20 ?? 0) * 115, -24, 30);
  momentum += clamp((r60 ?? 0) * 55, -18, 24);
  momentum += clamp((r5 ?? 0) * 75, -10, 12);
  if (dd60 != null && dd60 > -0.08) momentum += 6;
  if (dd60 != null && dd60 < -0.25) momentum -= 8;
  if (vol20 != null && vol20 > 0.9) momentum -= 8;
  if (vol20 != null && vol20 < 0.35) momentum += 4;

  const liquidity = scaleLog(turnover, 20_000_000, 1_200_000_000);
  const stability = clamp(80 - (vol20 ?? 0.55) * 55 + (dd60 ?? -0.12) * 40);
  const theme = themeScore(row, params);

  let score =
    params.momentumWeight * clamp(momentum) +
    params.liquidityWeight * liquidity +
    params.stabilityWeight * stability +
    params.themeWeight * theme;
  if (params.pullbackScoreWeight && !params.rankBlend) {
    score = score * (1 - params.pullbackScoreWeight) + pullback.pullbackAccumulationScore * params.pullbackScoreWeight;
  }
  if (params.reversalScoreWeight && !params.rankBlend) {
    score = score * (1 - params.reversalScoreWeight) + reversalStability.shortTermReversalScore * params.reversalScoreWeight;
  }
  if (params.turnoverStabilityScoreWeight && !params.rankBlend) {
    score = score * (1 - params.turnoverStabilityScoreWeight) + reversalStability.turnoverStabilityScore * params.turnoverStabilityScoreWeight;
  }
  if (params.freshTrendScoreWeight && !params.rankBlend) {
    score = score * (1 - params.freshTrendScoreWeight) + freshTrend.freshTrendScore * params.freshTrendScoreWeight;
  }

  return {
    code: row.code,
    name: row.name,
    market: row.market,
    industry: row.industry,
    concepts: row.concepts,
    relevance: row.relevance,
    source: row.source,
    universeSource: row.universeSource || row.source,
    score: Number(score.toFixed(4)),
    status: "scored",
    historyDays: history.length,
    priceAsOf: history[history.length - 1].close,
    r5,
    r20,
    r60,
    acceleration20vs60,
    dd60,
    vol20,
    avgTurnover20: turnover,
    pullbackAccumulationScore: pullback.pullbackAccumulationScore,
    pullbackDrawdown20: pullback.pullbackDrawdown20,
    pullbackSupportRatio20: pullback.pullbackSupportRatio20,
    pullbackVolumeRatio5v20: pullback.pullbackVolumeRatio5v20,
    volumeMomentumScore: volumeMomentum.volumeMomentumScore,
    volumeTurnoverRatio5v20: volumeMomentum.volumeTurnoverRatio5v20,
    shortTermReversalScore: reversalStability.shortTermReversalScore,
    shortTermReversalR3: reversalStability.shortTermReversalR3,
    shortTermDrawdown20: reversalStability.shortTermDrawdown20,
    shortTermSupportRatio20: reversalStability.shortTermSupportRatio20,
    turnoverCv20: reversalStability.turnoverCv20,
    turnoverStabilityScore: reversalStability.turnoverStabilityScore,
    freshTrendScore: freshTrend.freshTrendScore,
    freshAccelerationScore: freshTrend.freshAccelerationScore,
    trendMaturityPenaltyScore: freshTrend.trendMaturityPenaltyScore,
    high52wScore: high52w.high52wScore,
    high52wDistance: high52w.high52wDistance,
    high52wDaysSinceHigh: high52w.high52wDaysSinceHigh,
    maxDailyReturn20: lotterySpike.maxDailyReturn20,
    maxPositiveShare20: lotterySpike.maxPositiveShare20,
    lotterySpikeScore: lotterySpike.lotterySpikeScore,
    momentumScore: clamp(momentum),
    liquidityScore: liquidity,
    stabilityScore: stability,
    themeScore: theme,
  };
}

function universeEligibility(score, options = {}) {
  if (!options.enabled) return { eligible: true };
  const minAvgTurnover20 = options.minAvgTurnover20 ?? 0;
  if (minAvgTurnover20 > 0) {
    if (!Number.isFinite(score.avgTurnover20)) {
      return { eligible: false, reason: "universe_missing_avg_turnover" };
    }
    if (score.avgTurnover20 < minAvgTurnover20) {
      return { eligible: false, reason: "universe_low_avg_turnover" };
    }
  }

  const minPriceAsOf = options.minPriceAsOf ?? 0;
  if (minPriceAsOf > 0) {
    if (!Number.isFinite(score.priceAsOf)) {
      return { eligible: false, reason: "universe_missing_price" };
    }
    if (score.priceAsOf < minPriceAsOf) {
      return { eligible: false, reason: "universe_low_price" };
    }
  }

  const maxVol20 = options.maxVol20 ?? null;
  if (Number.isFinite(maxVol20) && Number.isFinite(score.vol20) && score.vol20 > maxVol20) {
    return { eligible: false, reason: "universe_high_volatility" };
  }

  if (options.excludeST && /(^|\s|\*)ST/.test(String(score.name || ""))) {
    return { eligible: false, reason: "universe_st_stock" };
  }
  return { eligible: true };
}

function limitUpThreshold(row, options = {}) {
  const raw = String(row.code || "").padStart(6, "0");
  const market = String(row.market || "");
  if (market === "港股通" || /港/.test(market) || /^\d{5}$/.test(raw)) return null;
  if (/北交所|新三板/.test(market) || /^(8|4|920|430|831|832|833|834|835|836|837|838|839|870|871|872|873|874)/.test(raw)) {
    return options.beijingLimitUpPct ?? 0.29;
  }
  if (/创业板|科创/.test(market) || /^(300|301|688|689)/.test(raw)) {
    return options.growthLimitUpPct ?? 0.194;
  }
  if (/ST/.test(String(row.name || ""))) return options.stLimitUpPct ?? 0.047;
  return options.mainLimitUpPct ?? 0.097;
}

function limitDownThreshold(row, options = {}) {
  const up = limitUpThreshold(row, options);
  return up == null ? null : -up;
}

function rowTurnover(row) {
  const close = Number(row?.close);
  const volume = Number(row?.volume);
  const amount = Number(row?.amount);
  if (Number.isFinite(amount) && amount > 0) return amount;
  return Number.isFinite(close) && Number.isFinite(volume) ? close * volume : null;
}

function entryTradability(score, kline, asOf, options = {}) {
  if (!options.enabled) return { tradable: true };
  const { history } = sliceKline(kline, asOf, asOf);
  const last = history[history.length - 1];
  const prev = history[history.length - 2];
  if (!last) return { tradable: false, reason: "entry_missing_price" };

  const close = Number(last.close);
  const high = Number(last.high ?? last.close);
  const volume = Number(last.volume);
  const amount = Number(last.amount);
  const turnover = rowTurnover(last);
  if (!Number.isFinite(close) || close <= 0) {
    return { tradable: false, reason: "entry_missing_price" };
  }
  if (Number.isFinite(volume) && volume <= 0) {
    return { tradable: false, reason: "entry_suspended_or_zero_volume", entryTurnover: turnover };
  }
  if (Number.isFinite(amount) && amount <= 0 && !Number.isFinite(volume)) {
    return { tradable: false, reason: "entry_suspended_or_zero_volume", entryTurnover: turnover };
  }
  const minTurnover = options.minTurnover ?? 0;
  if (minTurnover > 0 && Number.isFinite(turnover) && turnover < minTurnover) {
    return { tradable: false, reason: "entry_low_turnover", entryTurnover: turnover };
  }

  const prevClose = Number(prev?.close);
  const entryDayReturn = prevClose > 0 ? close / prevClose - 1 : null;
  const threshold = limitUpThreshold(score, options);
  const closeAtHighRatio = options.closeAtHighRatio ?? 0.995;
  const closeAtHigh = Number.isFinite(high) && high > 0 ? close >= high * closeAtHighRatio : false;
  if (threshold != null && Number.isFinite(entryDayReturn) && entryDayReturn >= threshold && closeAtHigh) {
    return {
      tradable: false,
      reason: "entry_limit_up_like",
      entryDayReturn,
      entryTurnover: turnover,
      entryCloseAtHigh: closeAtHigh,
    };
  }

  return {
    tradable: true,
    entryDayReturn,
    entryTurnover: turnover,
    entryCloseAtHigh: closeAtHigh,
  };
}

function exitTradability(score, rows, index, options = {}) {
  if (!options.enabled) return { tradable: true };
  const row = rows[index];
  const prev = rows[index - 1];
  if (!row) return { tradable: false, reason: "exit_missing_price" };

  const close = Number(row.close);
  const low = Number(row.low ?? row.close);
  const volume = Number(row.volume);
  const amount = Number(row.amount);
  const turnover = rowTurnover(row);
  if (!Number.isFinite(close) || close <= 0) {
    return { tradable: false, reason: "exit_missing_price" };
  }
  if (Number.isFinite(volume) && volume <= 0) {
    return { tradable: false, reason: "exit_suspended_or_zero_volume", exitTurnover: turnover };
  }
  if (Number.isFinite(amount) && amount <= 0 && !Number.isFinite(volume)) {
    return { tradable: false, reason: "exit_suspended_or_zero_volume", exitTurnover: turnover };
  }

  const prevClose = Number(prev?.close);
  const exitDayReturn = prevClose > 0 ? close / prevClose - 1 : null;
  const threshold = limitDownThreshold(score, options);
  const closeAtLowRatio = options.closeAtLowRatio ?? 1.005;
  const closeAtLow = Number.isFinite(low) && low > 0 ? close <= low * closeAtLowRatio : false;
  if (threshold != null && Number.isFinite(exitDayReturn) && exitDayReturn <= threshold && closeAtLow) {
    return {
      tradable: false,
      reason: "exit_limit_down_like",
      exitDayReturn,
      exitTurnover: turnover,
      exitCloseAtLow: closeAtLow,
    };
  }

  return {
    tradable: true,
    exitDayReturn,
    exitTurnover: turnover,
    exitCloseAtLow: closeAtLow,
  };
}

function returnSanityConfig(options = {}) {
  const cfg = options.returnSanity || {};
  return {
    enabled: cfg.enabled !== false,
    maxForwardReturn: cfg.maxForwardReturn ?? 5,
    minForwardReturn: cfg.minForwardReturn ?? -0.90,
    corporateActionPriceRatio: cfg.corporateActionPriceRatio ?? 4,
    corporateActionInverseVolumeRatio: cfg.corporateActionInverseVolumeRatio ?? 0.35,
  };
}

function findSuspectCorporateActionJump(sorted, entryIndex, exitIndex, cfg) {
  const priceRatioTrigger = cfg.corporateActionPriceRatio;
  const inverseVolumeRatio = cfg.corporateActionInverseVolumeRatio;
  if (!(priceRatioTrigger > 1) || !(inverseVolumeRatio > 0)) return null;
  const start = Math.max(1, entryIndex + 1);
  for (let i = start; i <= exitIndex; i += 1) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const prevClose = Number(prev?.close);
    const currClose = Number(curr?.close);
    const prevVolume = Number(prev?.volume);
    const currVolume = Number(curr?.volume);
    if (!(prevClose > 0) || !(currClose > 0) || !(prevVolume > 0) || !(currVolume > 0)) continue;
    const priceUpRatio = currClose / prevClose;
    const priceDownRatio = prevClose / currClose;
    const volumeRatio = currVolume / prevVolume;
    if (priceUpRatio >= priceRatioTrigger && volumeRatio <= inverseVolumeRatio) {
      return {
        sanityJumpDate: curr.date,
        sanityPriceRatio: priceUpRatio,
        sanityVolumeRatio: volumeRatio,
      };
    }
    if (priceDownRatio >= priceRatioTrigger && volumeRatio >= (1 / inverseVolumeRatio)) {
      return {
        sanityJumpDate: curr.date,
        sanityPriceRatio: 1 / priceDownRatio,
        sanityVolumeRatio: volumeRatio,
      };
    }
  }
  return null;
}

function returnSanityCheck(forwardReturnValue, sorted, entryIndex, exitIndex, options = {}) {
  const cfg = returnSanityConfig(options);
  if (!cfg.enabled) return { ok: true };
  if (!Number.isFinite(forwardReturnValue)) {
    return { ok: false, reason: "missing_future_return" };
  }
  if (Number.isFinite(cfg.maxForwardReturn) && forwardReturnValue > cfg.maxForwardReturn) {
    return {
      ok: false,
      reason: "extreme_forward_return",
      sanityMaxForwardReturn: cfg.maxForwardReturn,
    };
  }
  if (Number.isFinite(cfg.minForwardReturn) && forwardReturnValue < cfg.minForwardReturn) {
    return {
      ok: false,
      reason: "extreme_forward_loss",
      sanityMinForwardReturn: cfg.minForwardReturn,
    };
  }
  const jump = findSuspectCorporateActionJump(sorted, entryIndex, exitIndex, cfg);
  if (jump) {
    return {
      ok: false,
      reason: "suspect_corporate_action_jump",
      ...jump,
    };
  }
  return { ok: true };
}

function futureReturnDetails(kline, asOf, end, score = {}, options = {}) {
  const sorted = kline
    .filter((row) => row.date && Number.isFinite(Number(row.close)))
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  const interval = sorted.filter((row) => row.date >= asOf && row.date <= end);
  if (interval.length < 2) return { return: null, reason: "missing_future_return" };

  const entry = interval[0];
  const targetExit = interval[interval.length - 1];
  const entryIndex = sorted.findIndex((row) => row.date === entry.date);
  const targetExitIndex = sorted.findIndex((row) => row.date === targetExit.date);
  const entryPrice = Number(entry.close);
  if (!(entryPrice > 0)) return { return: null, reason: "missing_future_return" };

  let exit = targetExit;
  let exitIndex = targetExitIndex;
  let exitDelayDays = 0;
  let exitReason = null;
  let exitCheck = exitTradability(score, sorted, exitIndex, options);
  if (!exitCheck.tradable) {
    exitReason = exitCheck.reason;
    const maxDelay = options.maxExitDelayDays ?? 3;
    for (let delay = 1; delay <= maxDelay; delay += 1) {
      const candidateIndex = targetExitIndex + delay;
      const candidate = sorted[candidateIndex];
      if (!candidate) break;
      const candidateCheck = exitTradability(score, sorted, candidateIndex, options);
      if (candidateCheck.tradable) {
        exit = candidate;
        exitIndex = candidateIndex;
        exitDelayDays = delay;
        exitCheck = candidateCheck;
        break;
      }
    }
    if (exitIndex === targetExitIndex) {
      return {
        return: null,
        reason: exitReason || "exit_unresolved_after_delay",
        entryDate: entry.date,
        targetExitDate: targetExit.date,
        exitDate: targetExit.date,
        exitDelayDays: 0,
        exitDayReturn: exitCheck.exitDayReturn,
        exitTurnover: exitCheck.exitTurnover,
      };
    }
  }

  const exitPrice = Number(exit.close);
  const forwardReturnValue = exitPrice > 0 ? (exitPrice / entryPrice) - 1 : null;
  const sanity = returnSanityCheck(forwardReturnValue, sorted, entryIndex, exitIndex, options);
  if (!sanity.ok) {
    return {
      return: null,
      reason: sanity.reason,
      forwardReturn: forwardReturnValue,
      entryDate: entry.date,
      targetExitDate: targetExit.date,
      exitDate: exit.date,
      exitDelayDays,
      exitReason,
      entryPrice,
      exitPrice,
      exitDayReturn: exitCheck.exitDayReturn,
      exitTurnover: exitCheck.exitTurnover,
      exitCloseAtLow: exitCheck.exitCloseAtLow,
      ...sanity,
    };
  }
  return {
    return: forwardReturnValue,
    entryDate: entry.date,
    targetExitDate: targetExit.date,
    exitDate: exit.date,
    exitDelayDays,
    exitReason,
    entryPrice,
    exitPrice,
    exitDayReturn: exitCheck.exitDayReturn,
    exitTurnover: exitCheck.exitTurnover,
    exitCloseAtLow: exitCheck.exitCloseAtLow,
  };
}

function futureReturn(kline, asOf, end) {
  const details = futureReturnDetails(kline, asOf, end);
  return details.return;
}

function benchmarkReturn(kline, asOf, end) {
  return futureReturn(kline, asOf, end);
}

function normalizeCappedWeights(rawWeights, minWeight, maxWeight) {
  const n = rawWeights.length;
  if (!n) return [];
  const min = n * minWeight > 1 ? 1 / n : minWeight;
  const max = n * maxWeight < 1 ? 1 / n : maxWeight;
  const weights = new Array(n).fill(null);
  const fixed = new Array(n).fill(false);
  let remaining = 1;

  while (true) {
    const open = rawWeights.map((_, i) => i).filter((i) => !fixed[i]);
    if (!open.length) break;
    const totalRaw = open.reduce((sum, i) => sum + rawWeights[i], 0) || open.length;
    let changed = false;
    for (const i of open) {
      const desired = remaining * (rawWeights[i] || 1) / totalRaw;
      if (desired < min) {
        weights[i] = min;
        fixed[i] = true;
        remaining -= min;
        changed = true;
      } else if (desired > max) {
        weights[i] = max;
        fixed[i] = true;
        remaining -= max;
        changed = true;
      }
    }
    if (!changed) {
      for (const i of open) {
        weights[i] = remaining * (rawWeights[i] || 1) / totalRaw;
        fixed[i] = true;
      }
      remaining = 0;
      break;
    }
  }

  const drift = 1 - weights.reduce((sum, weight) => sum + weight, 0);
  if (Math.abs(drift) > 1e-10 && weights.length) {
    const adjustable = weights
      .map((weight, i) => ({ weight, i }))
      .filter(({ weight }) => weight + drift >= min - 1e-10 && weight + drift <= max + 1e-10)
      .sort((a, b) => b.weight - a.weight)[0];
    weights[adjustable ? adjustable.i : weights.length - 1] += drift;
  }
  return weights;
}

function assignRecommendedWeights(topRows, options = {}) {
  const minWeight = options.minWeight ?? 0.05;
  const maxWeight = options.maxWeight ?? 0.18;
  const pullbackTilt = options.pullbackTilt ?? 0;
  const rawWeights = topRows.map((row) => {
    const score = clamp(row.score ?? 50) / 100;
    const liquidity = clamp(row.liquidityScore ?? 50) / 100;
    const stability = clamp(row.stabilityScore ?? 50) / 100;
    const volPenalty = Math.max(0, (row.vol20 ?? 0.55) - 0.55) * 0.45;
    const drawdownPenalty = Math.max(0, Math.abs(Math.min(row.dd60 ?? 0, 0)) - 0.12) * 0.9;
    const cost = Number(row.executionCostRate);
    const costPenalty = Number.isFinite(cost) ? clamp((cost - 0.006) / 0.024, 0, 0.45) : 0;
    const riskMultiplier = clamp(1 - volPenalty - drawdownPenalty, 0.45, 1.15);
    const costMultiplier = 1 - costPenalty;
    const pullbackScore = Number(row.pullbackAccumulationScore);
    const pullbackMultiplier = Number.isFinite(pullbackScore)
      ? clamp(1 + ((clamp(pullbackScore) - 50) / 50) * pullbackTilt, 1 - pullbackTilt, 1 + pullbackTilt)
      : 1;
    return Math.max(0.01, (score ** 2) * (0.65 + liquidity * 0.25 + stability * 0.25) * riskMultiplier * costMultiplier * pullbackMultiplier);
  });
  const weights = normalizeCappedWeights(rawWeights, minWeight, maxWeight);
  return topRows.map((row, index) => ({
    ...row,
    recommendedWeight: weights[index],
    recommendedWeightPct: weights[index] * 100,
  }));
}

function weightedReturn(rows, field = "forwardReturn") {
  const weighted = rows
    .map((row) => Number(row.recommendedWeight) * Number(row[field]))
    .filter((x) => Number.isFinite(x));
  return weighted.length ? weighted.reduce((sum, x) => sum + x, 0) : null;
}

function executionCostRate(row, options = {}) {
  if (!options.enabled) return 0;
  const roundTripBps = options.roundTripBps ?? 35;
  const turnover = Number(row.avgTurnover20);
  const liquidityReference = options.liquidityReference ?? 300_000_000;
  const liquidityFloor = options.liquidityFloor ?? 20_000_000;
  let liquidityPressure = 0.45;
  if (Number.isFinite(turnover) && turnover > 0) {
    if (turnover >= liquidityReference) {
      liquidityPressure = 0;
    } else {
      const numerator = Math.log(liquidityReference / Math.max(turnover, liquidityFloor));
      const denominator = Math.log(liquidityReference / liquidityFloor) || 1;
      liquidityPressure = clamp(numerator / denominator, 0, 1);
    }
  }
  const volatility = Number(row.vol20);
  const volatilityPressure = Number.isFinite(volatility)
    ? clamp((volatility - (options.volatilityTrigger ?? 0.45)) / Math.max(0.001, options.volatilityFull ?? 0.85), 0, 1)
    : 0.25;
  const liquidityBps = liquidityPressure * (options.maxLiquidityBps ?? 80);
  const volatilityBps = volatilityPressure * (options.maxVolatilityBps ?? 60);
  const totalBps = roundTripBps + liquidityBps + volatilityBps;
  return Number(clamp(totalBps / 10000, 0, options.maxCostRate ?? 0.035).toFixed(6));
}

function weightedMeanField(rows, field) {
  const values = rows
    .map((row) => ({
      value: Number(row[field]),
      weight: Number.isFinite(Number(row.recommendedWeight)) ? Number(row.recommendedWeight) : null,
    }))
    .filter(({ value }) => Number.isFinite(value));
  if (!values.length) return null;
  const hasWeights = values.some(({ weight }) => Number.isFinite(weight) && weight > 0);
  if (!hasWeights) return mean(values.map(({ value }) => value));
  const totalWeight = values.reduce((sum, { weight }) => sum + (Number.isFinite(weight) && weight > 0 ? weight : 0), 0);
  if (totalWeight <= 0) return mean(values.map(({ value }) => value));
  return values.reduce((sum, { value, weight }) => sum + value * (Number.isFinite(weight) && weight > 0 ? weight : 0) / totalWeight, 0);
}

function benchmarkOverlayWeight(topRows, options = {}) {
  if (!options.enabled || !topRows.length) return 0;
  const benchmarkR20 = weightedMeanField(topRows, "benchmarkR20");
  const benchmarkR60 = weightedMeanField(topRows, "benchmarkR60");
  if (!Number.isFinite(benchmarkR20) && !Number.isFinite(benchmarkR60)) return 0;

  const trigger20 = options.trigger20 ?? 0.08;
  const strong20 = options.strong20 ?? 0.18;
  const trigger60 = options.trigger60 ?? 0.18;
  const strong60 = options.strong60 ?? 0.38;
  const beta20 = clamp(((benchmarkR20 ?? 0) - trigger20) / Math.max(0.001, strong20 - trigger20), 0, 1);
  const beta60 = clamp(((benchmarkR60 ?? 0) - trigger60) / Math.max(0.001, strong60 - trigger60), 0, 1);
  const betaScore = beta20 * 0.55 + beta60 * 0.45;
  const activation = options.activation ?? 0.30;
  if (betaScore < activation) return 0;

  const relativeR20 = weightedMeanField(topRows, "relativeR20");
  const relativeR60 = weightedMeanField(topRows, "relativeR60");
  const relativeAdvantage = (relativeR20 ?? 0) * 0.55 + (relativeR60 ?? 0) * 0.45;
  const advantageTrigger = options.advantageTrigger ?? 0.16;
  const advantageFull = options.advantageFull ?? 0.36;
  const strongStockDampener = clamp(
    1 - Math.max(0, relativeAdvantage - advantageTrigger) / Math.max(0.001, advantageFull - advantageTrigger),
    options.minDampener ?? 0.35,
    1
  );
  const weakRelativeBonus = clamp(Math.max(0, -relativeAdvantage) / (options.weakRelativeFull ?? 0.12), 0, 0.20);
  const minWeight = options.minWeight ?? 0.10;
  const maxWeight = options.maxWeight ?? 0.55;
  const rawWeight = minWeight + (maxWeight - minWeight) * clamp(betaScore + weakRelativeBonus, 0, 1);
  return Number(clamp(rawWeight * strongStockDampener, 0, maxWeight).toFixed(6));
}

function defensiveCashWeight(topRows, options = {}) {
  const cfg = options.defensiveCash || {};
  if (!cfg.enabled || !topRows.length) return 0;
  const benchmarkR20 = weightedMeanField(topRows, "benchmarkR20");
  const benchmarkR60 = weightedMeanField(topRows, "benchmarkR60");
  if (!Number.isFinite(benchmarkR20) && !Number.isFinite(benchmarkR60)) return 0;

  const trigger20 = cfg.trigger20 ?? -0.03;
  const full20 = cfg.full20 ?? -0.12;
  const trigger60 = cfg.trigger60 ?? -0.06;
  const full60 = cfg.full60 ?? -0.24;
  const risk20 = Number.isFinite(benchmarkR20)
    ? clamp((trigger20 - benchmarkR20) / Math.max(0.001, trigger20 - full20), 0, 1)
    : 0;
  const risk60 = Number.isFinite(benchmarkR60)
    ? clamp((trigger60 - benchmarkR60) / Math.max(0.001, trigger60 - full60), 0, 1)
    : 0;
  const riskScore = risk20 * (cfg.r20Weight ?? 0.55) + risk60 * (cfg.r60Weight ?? 0.45);
  if (riskScore < (cfg.activation ?? 0.25)) return 0;

  const minWeight = cfg.minWeight ?? 0.10;
  const maxWeight = cfg.maxWeight ?? 0.45;
  return Number(clamp(minWeight + (maxWeight - minWeight) * riskScore, 0, maxWeight).toFixed(6));
}

function topOnlyMaturityCashWeight(topRows, cfg = {}) {
  const topOnly = cfg.topOnlyMaturity || {};
  if (!topOnly.enabled || !topRows.length) return 0;
  const topR60 = weightedMeanField(topRows, "r60");
  const acceleration20vs60 = weightedMeanField(topRows, "acceleration20vs60");
  const topVol20 = weightedMeanField(topRows, "vol20");
  const freshTrendScore = weightedMeanField(topRows, "freshTrendScore");
  const relativeR60 = weightedMeanField(topRows, "relativeR60");
  if (
    !Number.isFinite(topR60) ||
    !Number.isFinite(acceleration20vs60) ||
    !Number.isFinite(topVol20) ||
    !Number.isFinite(freshTrendScore) ||
    !Number.isFinite(relativeR60)
  ) return 0;

  const minTopR60 = topOnly.minTopR60 ?? 0.65;
  const maxAcceleration20vs60 = topOnly.maxAcceleration20vs60 ?? -0.05;
  const minTopVol20 = topOnly.minTopVol20 ?? 0.62;
  const maxFreshTrendScore = topOnly.maxFreshTrendScore ?? 50;
  const minRelativeR60 = topOnly.minRelativeR60 ?? 0.45;
  if (
    topR60 < minTopR60 ||
    acceleration20vs60 > maxAcceleration20vs60 ||
    topVol20 < minTopVol20 ||
    freshTrendScore > maxFreshTrendScore ||
    relativeR60 < minRelativeR60
  ) return 0;

  const topTrendFull = topOnly.topTrendFull ?? 0.85;
  const accelerationFull = topOnly.accelerationFull ?? -0.15;
  const topVolFull = topOnly.topVolFull ?? 0.85;
  const freshFull = topOnly.freshFull ?? 35;
  const relativeFull = topOnly.relativeFull ?? 0.75;
  const trendScore = clamp((topR60 - minTopR60) / Math.max(0.001, topTrendFull - minTopR60), 0, 1);
  const decelerationScore = clamp(
    (maxAcceleration20vs60 - acceleration20vs60) / Math.max(0.001, maxAcceleration20vs60 - accelerationFull),
    0,
    1
  );
  const volScore = clamp((topVol20 - minTopVol20) / Math.max(0.001, topVolFull - minTopVol20), 0, 1);
  const staleFreshScore = clamp((maxFreshTrendScore - freshTrendScore) / Math.max(0.001, maxFreshTrendScore - freshFull), 0, 1);
  const relativeScore = clamp((relativeR60 - minRelativeR60) / Math.max(0.001, relativeFull - minRelativeR60), 0, 1);
  const riskScore =
    trendScore * (topOnly.topTrendWeight ?? 0.25) +
    decelerationScore * (topOnly.decelerationWeight ?? 0.25) +
    volScore * (topOnly.topVolWeight ?? 0.20) +
    staleFreshScore * (topOnly.staleFreshWeight ?? 0.20) +
    relativeScore * (topOnly.relativeWeight ?? 0.10);
  if (riskScore < (topOnly.activation ?? 0.20)) return 0;

  const minWeight = topOnly.minWeight ?? 0.10;
  const maxWeight = topOnly.maxWeight ?? 0.30;
  return Number(clamp(minWeight + (maxWeight - minWeight) * riskScore, 0, maxWeight).toFixed(6));
}

function topOnlyMaturityBenchmarkOverlayWeight(topRows, cfg = {}) {
  const topOnly = cfg.topOnlyMaturity || {};
  if (!topOnly.enabled || !topOnly.asBenchmarkOverlay || !topRows.length) return 0;
  const topOnlyWeight = topOnlyMaturityCashWeight(topRows, cfg);
  if (!Number.isFinite(topOnlyWeight) || topOnlyWeight <= 0) return 0;

  const benchmarkR20 = weightedMeanField(topRows, "benchmarkR20");
  const benchmarkR60 = weightedMeanField(topRows, "benchmarkR60");
  if (!Number.isFinite(benchmarkR20) || !Number.isFinite(benchmarkR60)) return 0;

  const minBenchmarkR20 = topOnly.minBenchmarkR20ForOverlay ?? -0.03;
  const maxBenchmarkR20 = topOnly.maxBenchmarkR20ForOverlay ?? 0.06;
  const minBenchmarkR60 = topOnly.minBenchmarkR60ForOverlay ?? -0.02;
  const maxBenchmarkR60 = topOnly.maxBenchmarkR60ForOverlay ?? 0.12;
  if (
    benchmarkR20 < minBenchmarkR20 ||
    benchmarkR20 > maxBenchmarkR20 ||
    benchmarkR60 < minBenchmarkR60 ||
    benchmarkR60 > maxBenchmarkR60
  ) return 0;

  return topOnlyWeight;
}

function freshDecayCrashCashWeight(topRows, cfg = {}) {
  const crash = cfg.freshDecayCrash || {};
  if (!crash.enabled || !topRows.length) return 0;
  const topR20 = weightedMeanField(topRows, "r20");
  const topR60 = weightedMeanField(topRows, "r60");
  const freshTrendScore = weightedMeanField(topRows, "freshTrendScore");
  const shortTermReversalScore = weightedMeanField(topRows, "shortTermReversalScore");
  const topVol20 = weightedMeanField(topRows, "vol20");
  const benchmarkR20 = weightedMeanField(topRows, "benchmarkR20");
  const benchmarkR60 = weightedMeanField(topRows, "benchmarkR60");
  if (
    !Number.isFinite(topR20) ||
    !Number.isFinite(topR60) ||
    !Number.isFinite(freshTrendScore) ||
    !Number.isFinite(shortTermReversalScore) ||
    !Number.isFinite(topVol20) ||
    !Number.isFinite(benchmarkR20) ||
    !Number.isFinite(benchmarkR60)
  ) return 0;

  const minTopR20 = crash.minTopR20 ?? 0.12;
  const minTopR60 = crash.minTopR60 ?? 0.35;
  const maxFreshTrendScore = crash.maxFreshTrendScore ?? 68;
  const maxShortTermReversalScore = crash.maxShortTermReversalScore ?? 65;
  const minTopVol20 = crash.minTopVol20 ?? 0.42;
  const minBenchmarkR20 = crash.minBenchmarkR20 ?? 0.04;
  const maxBenchmarkR20 = crash.maxBenchmarkR20 ?? 0.10;
  const minBenchmarkR60 = crash.minBenchmarkR60 ?? 0.18;
  if (
    topR20 < minTopR20 ||
    topR60 < minTopR60 ||
    freshTrendScore > maxFreshTrendScore ||
    shortTermReversalScore > maxShortTermReversalScore ||
    topVol20 < minTopVol20 ||
    benchmarkR20 < minBenchmarkR20 ||
    benchmarkR20 > maxBenchmarkR20 ||
    benchmarkR60 < minBenchmarkR60
  ) return 0;

  const topR20Full = crash.topR20Full ?? 0.24;
  const topR60Full = crash.topR60Full ?? 0.55;
  const freshFull = crash.freshFull ?? 50;
  const reversalFull = crash.reversalFull ?? 50;
  const volFull = crash.volFull ?? 0.70;
  const benchmarkDecelFull = crash.benchmarkDecelFull ?? 0.20;
  const r20Score = clamp((topR20 - minTopR20) / Math.max(0.001, topR20Full - minTopR20), 0, 1);
  const r60Score = clamp((topR60 - minTopR60) / Math.max(0.001, topR60Full - minTopR60), 0, 1);
  const freshDecayScore = clamp((maxFreshTrendScore - freshTrendScore) / Math.max(0.001, maxFreshTrendScore - freshFull), 0, 1);
  const reversalWeakScore = clamp(
    (maxShortTermReversalScore - shortTermReversalScore) / Math.max(0.001, maxShortTermReversalScore - reversalFull),
    0,
    1
  );
  const volScore = clamp((topVol20 - minTopVol20) / Math.max(0.001, volFull - minTopVol20), 0, 1);
  const benchmarkDecelScore = clamp(
    ((benchmarkR60 - benchmarkR20) - minBenchmarkR60) / Math.max(0.001, benchmarkDecelFull),
    0,
    1
  );
  const riskScore =
    r20Score * (crash.r20Weight ?? 0.12) +
    r60Score * (crash.r60Weight ?? 0.20) +
    freshDecayScore * (crash.freshDecayWeight ?? 0.24) +
    reversalWeakScore * (crash.reversalWeakWeight ?? 0.18) +
    volScore * (crash.volWeight ?? 0.14) +
    benchmarkDecelScore * (crash.benchmarkDecelWeight ?? 0.12);
  if (riskScore < (crash.activation ?? 0.20)) return 0;

  const minWeight = crash.minWeight ?? 0.20;
  const maxWeight = crash.maxWeight ?? 0.50;
  return Number(clamp(minWeight + (maxWeight - minWeight) * riskScore, 0, maxWeight).toFixed(6));
}

function pullbackCatchupOverlayWeight(topRows, options = {}) {
  const cfg = options.pullbackCatchupOverlay || {};
  if (!cfg.enabled || !topRows.length) return 0;
  const topR60 = weightedMeanField(topRows, "r60");
  const freshTrendScore = weightedMeanField(topRows, "freshTrendScore");
  const benchmarkR5 = weightedMeanField(topRows, "benchmarkR5");
  const benchmarkR20 = weightedMeanField(topRows, "benchmarkR20");
  const benchmarkR60 = weightedMeanField(topRows, "benchmarkR60");
  const relativeR20 = weightedMeanField(topRows, "relativeR20");
  const relativeMomentumScore = weightedMeanField(topRows, "relativeMomentumScore");
  const topVol20 = weightedMeanField(topRows, "vol20");
  if (
    !Number.isFinite(topR60) ||
    !Number.isFinite(freshTrendScore) ||
    !Number.isFinite(benchmarkR5) ||
    !Number.isFinite(benchmarkR20) ||
    !Number.isFinite(benchmarkR60) ||
    !Number.isFinite(relativeR20) ||
    !Number.isFinite(relativeMomentumScore) ||
    !Number.isFinite(topVol20)
  ) return 0;

  const minTopR60 = cfg.minTopR60 ?? 0.45;
  const minFreshTrendScore = cfg.minFreshTrendScore ?? 55;
  const maxFreshTrendScore = cfg.maxFreshTrendScore ?? 70;
  const maxBenchmarkR5 = cfg.maxBenchmarkR5 ?? -0.01;
  const minBenchmarkR20 = cfg.minBenchmarkR20 ?? 0.02;
  const maxBenchmarkR20 = cfg.maxBenchmarkR20 ?? 0.08;
  const minBenchmarkR60 = cfg.minBenchmarkR60 ?? 0.02;
  const maxBenchmarkR60 = cfg.maxBenchmarkR60 ?? 0.12;
  const minRelativeR20 = cfg.minRelativeR20 ?? 0.18;
  const minRelativeMomentumScore = cfg.minRelativeMomentumScore ?? 90;
  const maxTopVol20 = cfg.maxTopVol20 ?? 0.60;
  if (
    topR60 < minTopR60 ||
    freshTrendScore < minFreshTrendScore ||
    freshTrendScore > maxFreshTrendScore ||
    benchmarkR5 > maxBenchmarkR5 ||
    benchmarkR20 < minBenchmarkR20 ||
    benchmarkR20 > maxBenchmarkR20 ||
    benchmarkR60 < minBenchmarkR60 ||
    benchmarkR60 > maxBenchmarkR60 ||
    relativeR20 < minRelativeR20 ||
    relativeMomentumScore < minRelativeMomentumScore ||
    topVol20 > maxTopVol20
  ) return 0;

  const topTrendFull = cfg.topTrendFull ?? 0.65;
  const fullBenchmarkR5 = cfg.fullBenchmarkR5 ?? -0.04;
  const relativeR20Full = cfg.relativeR20Full ?? 0.30;
  const benchmarkR60Full = cfg.benchmarkR60Full ?? 0.10;
  const topTrendScore = clamp((topR60 - minTopR60) / Math.max(0.001, topTrendFull - minTopR60), 0, 1);
  const pullbackScore = clamp((maxBenchmarkR5 - benchmarkR5) / Math.max(0.001, maxBenchmarkR5 - fullBenchmarkR5), 0, 1);
  const relativeScore = clamp((relativeR20 - minRelativeR20) / Math.max(0.001, relativeR20Full - minRelativeR20), 0, 1);
  const freshMaturityScore = clamp(
    (maxFreshTrendScore - freshTrendScore) / Math.max(0.001, maxFreshTrendScore - minFreshTrendScore),
    0,
    1
  );
  const benchmarkWarmthScore = clamp((benchmarkR60 - minBenchmarkR60) / Math.max(0.001, benchmarkR60Full - minBenchmarkR60), 0, 1);
  const catchupScore =
    topTrendScore * (cfg.topTrendWeight ?? 0.25) +
    pullbackScore * (cfg.pullbackWeight ?? 0.30) +
    relativeScore * (cfg.relativeWeight ?? 0.25) +
    freshMaturityScore * (cfg.freshMaturityWeight ?? 0.12) +
    benchmarkWarmthScore * (cfg.benchmarkWarmthWeight ?? 0.08);
  if (catchupScore < (cfg.activation ?? 0.20)) return 0;

  const minWeight = cfg.minWeight ?? 0.12;
  const maxWeight = cfg.maxWeight ?? 0.28;
  return Number(clamp(minWeight + (maxWeight - minWeight) * catchupScore, 0, maxWeight).toFixed(6));
}

function exhaustionCashWeight(topRows, options = {}) {
  const cfg = options.exhaustionCash || {};
  if (!cfg.enabled || !topRows.length) return 0;
  const routedTopOnlyWeight = topOnlyMaturityBenchmarkOverlayWeight(topRows, cfg);
  const topOnlyWeight = routedTopOnlyWeight > 0 ? 0 : topOnlyMaturityCashWeight(topRows, cfg);
  const freshDecayWeight = freshDecayCrashCashWeight(topRows, cfg);
  const benchmarkR20 = weightedMeanField(topRows, "benchmarkR20");
  const benchmarkR60 = weightedMeanField(topRows, "benchmarkR60");
  if (!Number.isFinite(benchmarkR20) || !Number.isFinite(benchmarkR60) || benchmarkR60 <= 0) {
    return Math.max(topOnlyWeight, freshDecayWeight);
  }

  const minBenchmarkR20 = cfg.minBenchmarkR20 ?? 0;
  if (benchmarkR20 < minBenchmarkR20) return topOnlyWeight;
  const ratio = benchmarkR20 / benchmarkR60;
  const maxRatio = cfg.max20To60Ratio ?? 0.35;
  if (!Number.isFinite(ratio) || ratio > maxRatio) return topOnlyWeight;

  const trigger60 = cfg.trigger60 ?? 0.20;
  const full60 = cfg.full60 ?? 0.35;
  const trend60Score = clamp((benchmarkR60 - trigger60) / Math.max(0.001, full60 - trigger60), 0, 1);
  if (trend60Score <= 0) return Math.max(topOnlyWeight, freshDecayWeight);

  const ratioFull = cfg.ratioFull ?? 0.08;
  const ratioScore = clamp((maxRatio - ratio) / Math.max(0.001, maxRatio - ratioFull), 0, 1);
  const topR60 = weightedMeanField(topRows, "r60");
  const topVol20 = weightedMeanField(topRows, "vol20");
  if (!Number.isFinite(topR60) || !Number.isFinite(topVol20)) return Math.max(topOnlyWeight, freshDecayWeight);
  if (Number.isFinite(cfg.maxTopRelativeR20)) {
    const topRelativeR20 = weightedMeanField(topRows, "relativeR20");
    if (!Number.isFinite(topRelativeR20) || topRelativeR20 > cfg.maxTopRelativeR20) return Math.max(topOnlyWeight, freshDecayWeight);
  }
  if (Number.isFinite(cfg.maxRelativeMomentumScore)) {
    const relativeMomentumScore = weightedMeanField(topRows, "relativeMomentumScore");
    if (!Number.isFinite(relativeMomentumScore) || relativeMomentumScore > cfg.maxRelativeMomentumScore) return Math.max(topOnlyWeight, freshDecayWeight);
  }
  const minTopR60 = cfg.minTopR60 ?? 0.35;
  const minTopVol20 = cfg.minTopVol20 ?? 0.45;
  if (topR60 < minTopR60 || topVol20 < minTopVol20) return Math.max(topOnlyWeight, freshDecayWeight);

  const topTrendFull = cfg.topTrendFull ?? 0.65;
  const topVolFull = cfg.topVolFull ?? 0.75;
  const topTrendScore = clamp((topR60 - minTopR60) / Math.max(0.001, topTrendFull - minTopR60), 0, 1);
  const volScore = clamp((topVol20 - minTopVol20) / Math.max(0.001, topVolFull - minTopVol20), 0, 1);
  const riskScore =
    trend60Score * (cfg.benchmarkTrendWeight ?? 0.35) +
    ratioScore * (cfg.decelerationWeight ?? 0.35) +
    topTrendScore * (cfg.topTrendWeight ?? 0.15) +
    volScore * (cfg.topVolWeight ?? 0.15);
  if (riskScore < (cfg.activation ?? 0.25)) return Math.max(topOnlyWeight, freshDecayWeight);

  const minWeight = cfg.minWeight ?? 0.08;
  const maxWeight = cfg.maxWeight ?? 0.35;
  const indexWeight = Number(clamp(minWeight + (maxWeight - minWeight) * riskScore, 0, maxWeight).toFixed(6));
  return Math.max(indexWeight, topOnlyWeight, freshDecayWeight);
}

function adaptivePortfolioStats(topRows, options = {}) {
  const returnField = options.returnField || "forwardReturn";
  const benchmarkReturnField = options.benchmarkReturnField || "benchmarkForwardReturn";
  const weightedTopReturn = weightedReturn(topRows, returnField);
  const weightedBenchmarkReturn = weightedReturn(topRows, benchmarkReturnField);
  const maturityBenchmarkOverlayWeight = topOnlyMaturityBenchmarkOverlayWeight(topRows, options.exhaustionCash || {});
  const pullbackCatchupOverlayWeightValue = pullbackCatchupOverlayWeight(topRows, options);
  const overlayWeight = Number(clamp(
    benchmarkOverlayWeight(topRows, options) + maturityBenchmarkOverlayWeight + pullbackCatchupOverlayWeightValue,
    0,
    1
  ).toFixed(6));
  const weakMarketCashWeight = defensiveCashWeight(topRows, options);
  const exhaustionWeight = exhaustionCashWeight(topRows, options);
  const cashWeight = Math.min(1 - overlayWeight, Math.max(weakMarketCashWeight, exhaustionWeight));
  const cashReturn = options.defensiveCash?.cashReturn ?? 0;
  const adaptiveWeightedReturn = Number.isFinite(weightedTopReturn) && Number.isFinite(weightedBenchmarkReturn)
    ? weightedTopReturn * (1 - overlayWeight - cashWeight) + weightedBenchmarkReturn * overlayWeight + cashReturn * cashWeight
    : weightedTopReturn;
  const weightedExcessVsBenchmark = Number.isFinite(weightedTopReturn) && Number.isFinite(weightedBenchmarkReturn)
    ? weightedTopReturn - weightedBenchmarkReturn
    : null;
  const adaptiveExcessVsBenchmark = Number.isFinite(adaptiveWeightedReturn) && Number.isFinite(weightedBenchmarkReturn)
    ? adaptiveWeightedReturn - weightedBenchmarkReturn
    : null;
  return {
    benchmarkOverlayWeight: overlayWeight,
    maturityBenchmarkOverlayWeight,
    pullbackCatchupOverlayWeight: pullbackCatchupOverlayWeightValue,
    defensiveCashWeight: cashWeight,
    weakMarketCashWeight,
    exhaustionCashWeight: exhaustionWeight,
    weightedTopReturn,
    weightedBenchmarkReturn,
    weightedExcessVsBenchmark,
    adaptiveWeightedReturn,
    adaptiveExcessVsBenchmark,
  };
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const ax = Math.abs(x);
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function welchTTest(a, b) {
  const xs = a.filter((x) => Number.isFinite(x));
  const ys = b.filter((x) => Number.isFinite(x));
  const ma = mean(xs);
  const mb = mean(ys);
  const va = variance(xs);
  const vb = variance(ys);
  const na = xs.length;
  const nb = ys.length;
  if (na < 2 || nb < 2) return { t: null, pValue: null, meanA: ma, meanB: mb, nA: na, nB: nb };
  const se = Math.sqrt(va / na + vb / nb);
  if (!se) return { t: null, pValue: null, meanA: ma, meanB: mb, nA: na, nB: nb };
  const t = (ma - mb) / se;
  const pValue = 2 * (1 - normalCdf(Math.abs(t)));
  return { t, pValue, meanA: ma, meanB: mb, nA: na, nB: nb };
}

function quantilesByScore(rows, buckets = 10) {
  const returnField = rows.some((row) => Number.isFinite(row.netForwardReturn)) ? "netForwardReturn" : "forwardReturn";
  const sorted = rows.filter((row) => Number.isFinite(row[returnField])).slice().sort((a, b) => b.score - a.score);
  const out = [];
  for (let i = 0; i < buckets; i += 1) {
    const start = Math.floor((i * sorted.length) / buckets);
    const end = Math.floor(((i + 1) * sorted.length) / buckets);
    const bucket = sorted.slice(start, end);
    out.push({
      bucket: i + 1,
      count: bucket.length,
      avgScore: mean(bucket.map((row) => row.score)),
      avgReturn: mean(bucket.map((row) => row[returnField])),
      winRate: mean(bucket.map((row) => (row[returnField] > 0 ? 1 : 0))),
    });
  }
  return out;
}

function benchmarkValueForCode(row, scalarBenchmarkReturn, benchmarkReturnByCode) {
  if (benchmarkReturnByCode instanceof Map) return benchmarkReturnByCode.get(row.code) ?? null;
  if (benchmarkReturnByCode && typeof benchmarkReturnByCode === "object") return benchmarkReturnByCode[row.code] ?? null;
  return scalarBenchmarkReturn;
}

function evaluatePeriod({
  universe,
  klineByCode,
  asOf,
  end,
  topN = 10,
  params = defaultParams(),
  benchmarkReturn: periodBenchmarkReturn = null,
  benchmarkReturnByCode = null,
  benchmarkKlineByCode = null,
}) {
  let scored = [];
  const skipped = [];
  for (const row of universe) {
    const kline = klineByCode.get(row.code);
    if (!kline) {
      skipped.push({ code: row.code, name: row.name, reason: "missing_kline" });
      continue;
    }
    const score = scoreAtDate(row, kline, asOf, params);
    if (score.status !== "scored") {
      skipped.push({ code: row.code, name: row.name, reason: score.reason, historyDays: score.historyDays });
      continue;
    }
    const universeCheck = universeEligibility(score, params.universeFilter || {});
    if (!universeCheck.eligible) {
      skipped.push({
        code: row.code,
        name: row.name,
        reason: universeCheck.reason,
        historyDays: score.historyDays,
        avgTurnover20: score.avgTurnover20,
        priceAsOf: score.priceAsOf,
        vol20: score.vol20,
      });
      continue;
    }
    if (benchmarkKlineByCode) applyBenchmarkRelativeMetrics(score, benchmarkValueForCode(row, null, benchmarkKlineByCode), asOf, params);
    const tradability = entryTradability(score, kline, asOf, params.tradability || {});
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
    const fwd = futureReturnDetails(kline, asOf, end, score, {
      ...(params.tradability || {}),
      returnSanity: params.returnSanity,
    });
    if (fwd.return == null) {
      skipped.push({
        code: row.code,
        name: row.name,
        reason: fwd.reason || "missing_future_return",
        historyDays: score.historyDays,
        forwardReturn: fwd.forwardReturn,
        entryDate: fwd.entryDate,
        targetExitDate: fwd.targetExitDate,
        exitDate: fwd.exitDate,
        exitDelayDays: fwd.exitDelayDays,
        entryPrice: fwd.entryPrice,
        exitPrice: fwd.exitPrice,
        exitDayReturn: fwd.exitDayReturn,
        exitTurnover: fwd.exitTurnover,
        sanityMaxForwardReturn: fwd.sanityMaxForwardReturn,
        sanityMinForwardReturn: fwd.sanityMinForwardReturn,
        sanityJumpDate: fwd.sanityJumpDate,
        sanityPriceRatio: fwd.sanityPriceRatio,
        sanityVolumeRatio: fwd.sanityVolumeRatio,
      });
      continue;
    }
    scored.push({
      ...score,
      forwardReturn: fwd.return,
      entryDate: fwd.entryDate,
      targetExitDate: fwd.targetExitDate,
      exitDate: fwd.exitDate,
      exitDelayDays: fwd.exitDelayDays,
      exitReason: fwd.exitReason,
      exitDayReturn: fwd.exitDayReturn,
      exitTurnover: fwd.exitTurnover,
      exitCloseAtLow: fwd.exitCloseAtLow,
      executionCostRate: executionCostRate(score, params.executionCost || {}),
      benchmarkExecutionCostRate: params.executionCost?.enabled ? (params.executionCost.indexRoundTripBps ?? 8) / 10000 : 0,
      benchmarkForwardReturn: benchmarkValueForCode(row, periodBenchmarkReturn, benchmarkReturnByCode),
    });
  }
  for (const row of scored) {
    row.netForwardReturn = Number.isFinite(row.forwardReturn) && Number.isFinite(row.executionCostRate)
      ? row.forwardReturn - row.executionCostRate
      : row.forwardReturn;
    row.netBenchmarkForwardReturn = Number.isFinite(row.benchmarkForwardReturn) && Number.isFinite(row.benchmarkExecutionCostRate)
      ? row.benchmarkForwardReturn - row.benchmarkExecutionCostRate
      : row.benchmarkForwardReturn;
  }
  applyIndustryMomentumMetrics(scored, params);
  applyDynamicGroupMetrics(scored, params.dynamicGroupMetrics || {});
  scored = applyDynamicGroupUniverseFilter(scored, skipped, params.universeFilter?.dynamicGroup || {});
  if (params.rankBlend) applyCrossSectionalRankScore(scored, params);
  scored.sort((a, b) => b.score - a.score);
  const top = assignRecommendedWeights(scored.slice(0, topN), params.weighting || {});
  const rest = scored.slice(topN);
  const universeReturns = scored.map((row) => row.forwardReturn);
  const netUniverseReturns = scored.map((row) => row.netForwardReturn);
  const topReturns = top.map((row) => row.forwardReturn);
  const netTopReturns = top.map((row) => row.netForwardReturn);
  const restReturns = rest.map((row) => row.forwardReturn);
  const netRestReturns = rest.map((row) => row.netForwardReturn);
  const universeBenchmarkReturns = scored.map((row) => row.benchmarkForwardReturn);
  const netUniverseBenchmarkReturns = scored.map((row) => row.netBenchmarkForwardReturn);
  const topBenchmarkReturns = top.map((row) => row.benchmarkForwardReturn);
  const netTopBenchmarkReturns = top.map((row) => row.netBenchmarkForwardReturn);
  const universeMeanReturn = mean(universeReturns);
  const netUniverseMeanReturn = mean(netUniverseReturns);
  const topMeanReturn = mean(topReturns);
  const netTopMeanReturn = mean(netTopReturns);
  const weightedTopReturn = weightedReturn(top);
  const netWeightedTopReturn = weightedReturn(top, "netForwardReturn");
  const restMeanReturn = mean(restReturns);
  const netRestMeanReturn = mean(netRestReturns);
  const universeBenchmarkReturn = mean(universeBenchmarkReturns);
  const netUniverseBenchmarkReturn = mean(netUniverseBenchmarkReturns);
  const topBenchmarkReturn = mean(topBenchmarkReturns);
  const netTopBenchmarkReturn = mean(netTopBenchmarkReturns);
  const weightedBenchmarkReturn = weightedReturn(top, "benchmarkForwardReturn");
  const netWeightedBenchmarkReturn = weightedReturn(top, "netBenchmarkForwardReturn");
  const adaptiveStats = adaptivePortfolioStats(top, params.benchmarkOverlay || {});
  const netAdaptiveStats = adaptivePortfolioStats(top, {
    ...(params.benchmarkOverlay || {}),
    returnField: "netForwardReturn",
    benchmarkReturnField: "netBenchmarkForwardReturn",
  });
  const excessReturn = Number.isFinite(topMeanReturn) && Number.isFinite(universeMeanReturn)
    ? topMeanReturn - universeMeanReturn
    : null;
  const netExcessReturn = Number.isFinite(netTopMeanReturn) && Number.isFinite(netUniverseMeanReturn)
    ? netTopMeanReturn - netUniverseMeanReturn
    : null;
  const weightedExcessReturn = Number.isFinite(weightedTopReturn) && Number.isFinite(universeMeanReturn)
    ? weightedTopReturn - universeMeanReturn
    : null;
  const netWeightedExcessReturn = Number.isFinite(netWeightedTopReturn) && Number.isFinite(netUniverseMeanReturn)
    ? netWeightedTopReturn - netUniverseMeanReturn
    : null;
  const topExcessVsBenchmark = Number.isFinite(topMeanReturn) && Number.isFinite(topBenchmarkReturn)
    ? topMeanReturn - topBenchmarkReturn
    : null;
  const netTopExcessVsBenchmark = Number.isFinite(netTopMeanReturn) && Number.isFinite(netTopBenchmarkReturn)
    ? netTopMeanReturn - netTopBenchmarkReturn
    : null;
  const weightedExcessVsBenchmark = Number.isFinite(weightedTopReturn) && Number.isFinite(weightedBenchmarkReturn)
    ? weightedTopReturn - weightedBenchmarkReturn
    : null;
  const netWeightedExcessVsBenchmark = Number.isFinite(netWeightedTopReturn) && Number.isFinite(netWeightedBenchmarkReturn)
    ? netWeightedTopReturn - netWeightedBenchmarkReturn
    : null;
  const adaptiveWeightedExcessReturn = Number.isFinite(adaptiveStats.adaptiveWeightedReturn) && Number.isFinite(universeMeanReturn)
    ? adaptiveStats.adaptiveWeightedReturn - universeMeanReturn
    : null;
  const netAdaptiveWeightedExcessReturn = Number.isFinite(netAdaptiveStats.adaptiveWeightedReturn) && Number.isFinite(netUniverseMeanReturn)
    ? netAdaptiveStats.adaptiveWeightedReturn - netUniverseMeanReturn
    : null;
  const universeExcessVsBenchmark = Number.isFinite(universeMeanReturn) && Number.isFinite(universeBenchmarkReturn)
    ? universeMeanReturn - universeBenchmarkReturn
    : null;
  const netUniverseExcessVsBenchmark = Number.isFinite(netUniverseMeanReturn) && Number.isFinite(netUniverseBenchmarkReturn)
    ? netUniverseMeanReturn - netUniverseBenchmarkReturn
    : null;
  return {
    asOf,
    end,
    topN,
    params,
    scoredCount: scored.length,
    skippedCount: skipped.length,
    top,
    scored,
    skipped,
    universeMeanReturn,
    netUniverseMeanReturn,
    topMeanReturn,
    netTopMeanReturn,
    weightedTopReturn,
    netWeightedTopReturn,
    adaptiveWeightedTopReturn: adaptiveStats.adaptiveWeightedReturn,
    netAdaptiveWeightedTopReturn: netAdaptiveStats.adaptiveWeightedReturn,
    benchmarkOverlayWeight: adaptiveStats.benchmarkOverlayWeight,
    defensiveCashWeight: adaptiveStats.defensiveCashWeight,
    weakMarketCashWeight: adaptiveStats.weakMarketCashWeight,
    exhaustionCashWeight: adaptiveStats.exhaustionCashWeight,
    restMeanReturn,
    netRestMeanReturn,
    benchmarkReturn: universeBenchmarkReturn ?? periodBenchmarkReturn,
    netBenchmarkReturn: netUniverseBenchmarkReturn ?? periodBenchmarkReturn,
    topBenchmarkReturn,
    netTopBenchmarkReturn,
    weightedBenchmarkReturn,
    netWeightedBenchmarkReturn,
    excessReturn,
    netExcessReturn,
    weightedExcessReturn,
    netWeightedExcessReturn,
    adaptiveWeightedExcessReturn,
    netAdaptiveWeightedExcessReturn,
    topExcessVsBenchmark,
    netTopExcessVsBenchmark,
    weightedExcessVsBenchmark,
    netWeightedExcessVsBenchmark,
    adaptiveExcessVsBenchmark: adaptiveStats.adaptiveExcessVsBenchmark,
    netAdaptiveExcessVsBenchmark: netAdaptiveStats.adaptiveExcessVsBenchmark,
    universeExcessVsBenchmark,
    netUniverseExcessVsBenchmark,
    topWinRate: mean(topReturns.map((r) => (r > 0 ? 1 : 0))),
    netTopWinRate: mean(netTopReturns.map((r) => (r > 0 ? 1 : 0))),
    universeWinRate: mean(universeReturns.map((r) => (r > 0 ? 1 : 0))),
    netUniverseWinRate: mean(netUniverseReturns.map((r) => (r > 0 ? 1 : 0))),
    welchTopVsRest: welchTTest(topReturns, restReturns),
    netWelchTopVsRest: welchTTest(netTopReturns, netRestReturns),
    deciles: quantilesByScore(scored, 10),
  };
}

function defaultParams() {
  return {
    name: "balanced_v2",
    momentumWeight: 0.34,
    liquidityWeight: 0.24,
    stabilityWeight: 0.24,
    themeWeight: 0.18,
    minHistoryDays: 65,
  };
}

function paramGrid() {
  return [
    { name: "momentum_theme_v1", momentumWeight: 0.48, liquidityWeight: 0.18, stabilityWeight: 0.18, themeWeight: 0.16, minHistoryDays: 65 },
    { name: "balanced_v2", momentumWeight: 0.34, liquidityWeight: 0.24, stabilityWeight: 0.24, themeWeight: 0.18, minHistoryDays: 65 },
    { name: "breakout_v3", momentumWeight: 0.62, liquidityWeight: 0.16, stabilityWeight: 0.10, themeWeight: 0.12, minHistoryDays: 65 },
    { name: "quality_trend_v4", momentumWeight: 0.38, liquidityWeight: 0.18, stabilityWeight: 0.32, themeWeight: 0.12, minHistoryDays: 65 },
    { name: "theme_liquid_v5", momentumWeight: 0.34, liquidityWeight: 0.30, stabilityWeight: 0.12, themeWeight: 0.24, minHistoryDays: 65 },
    {
      name: "rank_momentum_risk_v6",
      momentumWeight: 0.42,
      liquidityWeight: 0.18,
      stabilityWeight: 0.24,
      themeWeight: 0.16,
      minHistoryDays: 65,
      rankBlend: true,
      rankMomentumWeight: 0.44,
      rankStabilityWeight: 0.24,
      rankLiquidityWeight: 0.16,
      rankThemeWeight: 0.08,
      rankConsistencyWeight: 0.08,
      rankRawScoreWeight: 0.12,
      rankOverheatPenalty: 8,
      weighting: { minWeight: 0.06, maxWeight: 0.16 },
    },
    {
      name: "rank_breakout_liquid_v7",
      momentumWeight: 0.58,
      liquidityWeight: 0.18,
      stabilityWeight: 0.12,
      themeWeight: 0.12,
      minHistoryDays: 65,
      rankBlend: true,
      rankMomentumWeight: 0.52,
      rankStabilityWeight: 0.16,
      rankLiquidityWeight: 0.18,
      rankThemeWeight: 0.06,
      rankConsistencyWeight: 0.08,
      rankRawScoreWeight: 0.10,
      rankOverheatPenalty: 10,
      weighting: { minWeight: 0.06, maxWeight: 0.17 },
    },
    {
      name: "rank_balanced_alpha_v8",
      momentumWeight: 0.36,
      liquidityWeight: 0.22,
      stabilityWeight: 0.28,
      themeWeight: 0.14,
      minHistoryDays: 65,
      rankBlend: true,
      rankMomentumWeight: 0.36,
      rankStabilityWeight: 0.28,
      rankLiquidityWeight: 0.20,
      rankThemeWeight: 0.08,
      rankConsistencyWeight: 0.08,
      rankRawScoreWeight: 0.14,
      rankOverheatPenalty: 7,
      weighting: { minWeight: 0.06, maxWeight: 0.15 },
    },
    {
      name: "rank_theme_momentum_v9",
      momentumWeight: 0.40,
      liquidityWeight: 0.16,
      stabilityWeight: 0.18,
      themeWeight: 0.26,
      minHistoryDays: 65,
      rankBlend: true,
      rankMomentumWeight: 0.40,
      rankStabilityWeight: 0.18,
      rankLiquidityWeight: 0.14,
      rankThemeWeight: 0.20,
      rankConsistencyWeight: 0.08,
      rankRawScoreWeight: 0.12,
      rankOverheatPenalty: 8,
      weighting: { minWeight: 0.06, maxWeight: 0.16 },
    },
    {
      name: "rank_low_vol_trend_v10",
      momentumWeight: 0.34,
      liquidityWeight: 0.20,
      stabilityWeight: 0.34,
      themeWeight: 0.12,
      minHistoryDays: 65,
      rankBlend: true,
      rankMomentumWeight: 0.34,
      rankStabilityWeight: 0.36,
      rankLiquidityWeight: 0.18,
      rankThemeWeight: 0.04,
      rankConsistencyWeight: 0.08,
      rankRawScoreWeight: 0.14,
      rankOverheatPenalty: 7,
      weighting: { minWeight: 0.06, maxWeight: 0.15 },
    },
    {
      name: "rank_relative_theme_v11",
      momentumWeight: 0.38,
      liquidityWeight: 0.16,
      stabilityWeight: 0.20,
      themeWeight: 0.26,
      minHistoryDays: 65,
      rankBlend: true,
      rankMomentumWeight: 0.30,
      rankRelativeWeight: 0.30,
      rankStabilityWeight: 0.18,
      rankLiquidityWeight: 0.12,
      rankThemeWeight: 0.06,
      rankConsistencyWeight: 0.04,
      rankRawScoreWeight: 0.08,
      rankOverheatPenalty: 9,
      weighting: { minWeight: 0.06, maxWeight: 0.16 },
    },
    {
      name: "rank_relative_risk_v12",
      momentumWeight: 0.34,
      liquidityWeight: 0.18,
      stabilityWeight: 0.34,
      themeWeight: 0.14,
      minHistoryDays: 65,
      rankBlend: true,
      rankMomentumWeight: 0.24,
      rankRelativeWeight: 0.34,
      rankStabilityWeight: 0.26,
      rankLiquidityWeight: 0.12,
      rankThemeWeight: 0.02,
      rankConsistencyWeight: 0.02,
      rankRawScoreWeight: 0.10,
      rankOverheatPenalty: 8,
      weighting: { minWeight: 0.06, maxWeight: 0.15 },
    },
    {
      name: "rank_industry_relative_v13",
      momentumWeight: 0.36,
      liquidityWeight: 0.16,
      stabilityWeight: 0.20,
      themeWeight: 0.28,
      minHistoryDays: 65,
      rankBlend: true,
      rankMomentumWeight: 0.22,
      rankRelativeWeight: 0.25,
      rankIndustryWeight: 0.22,
      rankStabilityWeight: 0.13,
      rankLiquidityWeight: 0.08,
      rankThemeWeight: 0.06,
      rankConsistencyWeight: 0.04,
      rankRawScoreWeight: 0.08,
      rankOverheatPenalty: 8,
      weighting: { minWeight: 0.06, maxWeight: 0.16 },
    },
    {
      name: "rank_industry_breakout_v14",
      momentumWeight: 0.48,
      liquidityWeight: 0.14,
      stabilityWeight: 0.14,
      themeWeight: 0.24,
      minHistoryDays: 65,
      rankBlend: true,
      rankMomentumWeight: 0.30,
      rankRelativeWeight: 0.18,
      rankIndustryWeight: 0.26,
      rankStabilityWeight: 0.08,
      rankLiquidityWeight: 0.08,
      rankThemeWeight: 0.06,
      rankConsistencyWeight: 0.04,
      rankRawScoreWeight: 0.06,
      rankOverheatPenalty: 10,
      weighting: { minWeight: 0.06, maxWeight: 0.17 },
    },
    {
      name: "rank_relative_theme_overlay_v15",
      momentumWeight: 0.38,
      liquidityWeight: 0.16,
      stabilityWeight: 0.20,
      themeWeight: 0.26,
      minHistoryDays: 65,
      rankBlend: true,
      rankMomentumWeight: 0.30,
      rankRelativeWeight: 0.30,
      rankStabilityWeight: 0.18,
      rankLiquidityWeight: 0.12,
      rankThemeWeight: 0.06,
      rankConsistencyWeight: 0.04,
      rankRawScoreWeight: 0.08,
      rankOverheatPenalty: 9,
      benchmarkOverlay: { enabled: true, trigger20: 0.08, strong20: 0.18, trigger60: 0.18, strong60: 0.38, minWeight: 0.10, maxWeight: 0.55 },
      weighting: { minWeight: 0.06, maxWeight: 0.16 },
    },
    {
      name: "rank_theme_momentum_overlay_v16",
      momentumWeight: 0.40,
      liquidityWeight: 0.16,
      stabilityWeight: 0.18,
      themeWeight: 0.26,
      minHistoryDays: 65,
      rankBlend: true,
      rankMomentumWeight: 0.40,
      rankStabilityWeight: 0.18,
      rankLiquidityWeight: 0.14,
      rankThemeWeight: 0.20,
      rankConsistencyWeight: 0.08,
      rankRawScoreWeight: 0.12,
      rankOverheatPenalty: 8,
      benchmarkOverlay: { enabled: true, trigger20: 0.08, strong20: 0.18, trigger60: 0.18, strong60: 0.38, minWeight: 0.10, maxWeight: 0.55 },
      weighting: { minWeight: 0.06, maxWeight: 0.16 },
    },
    {
      name: "rank_acceleration_relative_v17",
      momentumWeight: 0.34,
      liquidityWeight: 0.16,
      stabilityWeight: 0.20,
      themeWeight: 0.30,
      minHistoryDays: 65,
      rankBlend: true,
      rankMomentumWeight: 0.18,
      rankAccelerationWeight: 0.26,
      rankRelativeWeight: 0.24,
      rankStabilityWeight: 0.14,
      rankLiquidityWeight: 0.10,
      rankThemeWeight: 0.04,
      rankConsistencyWeight: 0.04,
      rankRawScoreWeight: 0.06,
      rankOverheatPenalty: 8,
      weighting: { minWeight: 0.06, maxWeight: 0.16 },
    },
    {
      name: "rank_acceleration_theme_hybrid_v18",
      momentumWeight: 0.34,
      liquidityWeight: 0.16,
      stabilityWeight: 0.21,
      themeWeight: 0.29,
      minHistoryDays: 65,
      rankBlend: true,
      rankMomentumWeight: 0.22,
      rankAccelerationWeight: 0.18,
      rankRelativeWeight: 0.27,
      rankStabilityWeight: 0.14,
      rankLiquidityWeight: 0.09,
      rankThemeWeight: 0.06,
      rankConsistencyWeight: 0.04,
      rankRawScoreWeight: 0.07,
      rankOverheatPenalty: 8,
      weighting: { minWeight: 0.06, maxWeight: 0.16 },
    },
    {
      name: "rank_acceleration_theme_attack_v19",
      momentumWeight: 0.36,
      liquidityWeight: 0.15,
      stabilityWeight: 0.18,
      themeWeight: 0.31,
      minHistoryDays: 65,
      rankBlend: true,
      rankMomentumWeight: 0.20,
      rankAccelerationWeight: 0.24,
      rankRelativeWeight: 0.25,
      rankStabilityWeight: 0.11,
      rankLiquidityWeight: 0.08,
      rankThemeWeight: 0.08,
      rankConsistencyWeight: 0.04,
      rankRawScoreWeight: 0.07,
      rankOverheatPenalty: 9,
      weighting: { minWeight: 0.06, maxWeight: 0.17 },
    },
    {
      name: "rank_acceleration_theme_resilient_v20",
      momentumWeight: 0.32,
      liquidityWeight: 0.17,
      stabilityWeight: 0.24,
      themeWeight: 0.27,
      minHistoryDays: 65,
      rankBlend: true,
      rankMomentumWeight: 0.18,
      rankAccelerationWeight: 0.20,
      rankRelativeWeight: 0.28,
      rankStabilityWeight: 0.17,
      rankLiquidityWeight: 0.09,
      rankThemeWeight: 0.06,
      rankConsistencyWeight: 0.04,
      rankRawScoreWeight: 0.07,
      rankOverheatPenalty: 8,
      weighting: { minWeight: 0.06, maxWeight: 0.16 },
    },
    {
      name: "rank_acceleration_theme_attack_overlay_v21",
      momentumWeight: 0.36,
      liquidityWeight: 0.15,
      stabilityWeight: 0.18,
      themeWeight: 0.31,
      minHistoryDays: 65,
      rankBlend: true,
      rankMomentumWeight: 0.20,
      rankAccelerationWeight: 0.24,
      rankRelativeWeight: 0.25,
      rankStabilityWeight: 0.11,
      rankLiquidityWeight: 0.08,
      rankThemeWeight: 0.08,
      rankConsistencyWeight: 0.04,
      rankRawScoreWeight: 0.07,
      rankOverheatPenalty: 9,
      benchmarkOverlay: { enabled: true, trigger20: 0.04, strong20: 0.12, trigger60: 0.08, strong60: 0.22, activation: 0.20, minWeight: 0.08, maxWeight: 0.45, minDampener: 0.35 },
      weighting: { minWeight: 0.06, maxWeight: 0.17 },
    },
    {
      name: "rank_tradable_acceleration_balanced_v22",
      momentumWeight: 0.35,
      liquidityWeight: 0.18,
      stabilityWeight: 0.21,
      themeWeight: 0.26,
      minHistoryDays: 65,
      rankBlend: true,
      rankMomentumWeight: 0.26,
      rankAccelerationWeight: 0.12,
      rankRelativeWeight: 0.30,
      rankStabilityWeight: 0.16,
      rankLiquidityWeight: 0.10,
      rankThemeWeight: 0.04,
      rankConsistencyWeight: 0.02,
      rankRawScoreWeight: 0.06,
      rankOverheatPenalty: 10,
      weighting: { minWeight: 0.06, maxWeight: 0.16 },
    },
    {
      name: "rank_tradable_relative_recovery_v23",
      momentumWeight: 0.36,
      liquidityWeight: 0.16,
      stabilityWeight: 0.22,
      themeWeight: 0.26,
      minHistoryDays: 65,
      rankBlend: true,
      rankMomentumWeight: 0.28,
      rankAccelerationWeight: 0.10,
      rankRelativeWeight: 0.32,
      rankStabilityWeight: 0.16,
      rankLiquidityWeight: 0.08,
      rankThemeWeight: 0.04,
      rankConsistencyWeight: 0.02,
      rankRawScoreWeight: 0.07,
      rankOverheatPenalty: 9,
      weighting: { minWeight: 0.06, maxWeight: 0.16 },
    },
    {
      name: "rank_tradable_liquid_attack_v24",
      momentumWeight: 0.34,
      liquidityWeight: 0.22,
      stabilityWeight: 0.18,
      themeWeight: 0.26,
      minHistoryDays: 65,
      rankBlend: true,
      rankMomentumWeight: 0.22,
      rankAccelerationWeight: 0.16,
      rankRelativeWeight: 0.26,
      rankStabilityWeight: 0.13,
      rankLiquidityWeight: 0.14,
      rankThemeWeight: 0.06,
      rankConsistencyWeight: 0.03,
      rankRawScoreWeight: 0.06,
      rankOverheatPenalty: 10,
      weighting: { minWeight: 0.06, maxWeight: 0.16 },
    },
    {
      name: "rank_pullback_accumulation_v25",
      experimental: true,
      momentumWeight: 0.34,
      liquidityWeight: 0.17,
      stabilityWeight: 0.22,
      themeWeight: 0.27,
      minHistoryDays: 65,
      rankBlend: true,
      rankMomentumWeight: 0.20,
      rankAccelerationWeight: 0.12,
      rankPullbackWeight: 0.20,
      rankRelativeWeight: 0.24,
      rankStabilityWeight: 0.14,
      rankLiquidityWeight: 0.08,
      rankThemeWeight: 0.04,
      rankConsistencyWeight: 0.02,
      rankRawScoreWeight: 0.06,
      rankOverheatPenalty: 10,
      weighting: { minWeight: 0.06, maxWeight: 0.16 },
    },
    {
      name: "rank_pullback_relative_v26",
      experimental: true,
      momentumWeight: 0.33,
      liquidityWeight: 0.16,
      stabilityWeight: 0.23,
      themeWeight: 0.28,
      minHistoryDays: 65,
      rankBlend: true,
      rankMomentumWeight: 0.18,
      rankAccelerationWeight: 0.10,
      rankPullbackWeight: 0.18,
      rankRelativeWeight: 0.30,
      rankStabilityWeight: 0.16,
      rankLiquidityWeight: 0.08,
      rankThemeWeight: 0.06,
      rankConsistencyWeight: 0.02,
      rankRawScoreWeight: 0.06,
      rankOverheatPenalty: 10,
      weighting: { minWeight: 0.06, maxWeight: 0.16 },
    },
    {
      name: "rank_pullback_attack_v27",
      experimental: true,
      momentumWeight: 0.36,
      liquidityWeight: 0.15,
      stabilityWeight: 0.18,
      themeWeight: 0.31,
      minHistoryDays: 65,
      rankBlend: true,
      rankMomentumWeight: 0.20,
      rankAccelerationWeight: 0.18,
      rankPullbackWeight: 0.18,
      rankRelativeWeight: 0.24,
      rankStabilityWeight: 0.10,
      rankLiquidityWeight: 0.08,
      rankThemeWeight: 0.08,
      rankConsistencyWeight: 0.02,
      rankRawScoreWeight: 0.06,
      rankOverheatPenalty: 11,
      weighting: { minWeight: 0.06, maxWeight: 0.17 },
    },
    {
      name: "rank_volume_momentum_balanced_v28",
      experimental: true,
      momentumWeight: 0.35,
      liquidityWeight: 0.18,
      stabilityWeight: 0.20,
      themeWeight: 0.27,
      minHistoryDays: 65,
      rankBlend: true,
      rankMomentumWeight: 0.20,
      rankAccelerationWeight: 0.12,
      rankVolumeMomentumWeight: 0.20,
      rankRelativeWeight: 0.24,
      rankStabilityWeight: 0.14,
      rankLiquidityWeight: 0.08,
      rankThemeWeight: 0.04,
      rankConsistencyWeight: 0.02,
      rankRawScoreWeight: 0.06,
      rankOverheatPenalty: 10,
      weighting: { minWeight: 0.06, maxWeight: 0.16 },
    },
    {
      name: "rank_volume_relative_v29",
      experimental: true,
      momentumWeight: 0.34,
      liquidityWeight: 0.17,
      stabilityWeight: 0.21,
      themeWeight: 0.28,
      minHistoryDays: 65,
      rankBlend: true,
      rankMomentumWeight: 0.18,
      rankAccelerationWeight: 0.10,
      rankVolumeMomentumWeight: 0.18,
      rankRelativeWeight: 0.30,
      rankStabilityWeight: 0.14,
      rankLiquidityWeight: 0.08,
      rankThemeWeight: 0.06,
      rankConsistencyWeight: 0.02,
      rankRawScoreWeight: 0.06,
      rankOverheatPenalty: 10,
      weighting: { minWeight: 0.06, maxWeight: 0.16 },
    },
    {
      name: "rank_volume_attack_v30",
      experimental: true,
      momentumWeight: 0.38,
      liquidityWeight: 0.15,
      stabilityWeight: 0.17,
      themeWeight: 0.30,
      minHistoryDays: 65,
      rankBlend: true,
      rankMomentumWeight: 0.18,
      rankAccelerationWeight: 0.20,
      rankVolumeMomentumWeight: 0.18,
      rankRelativeWeight: 0.23,
      rankStabilityWeight: 0.10,
      rankLiquidityWeight: 0.08,
      rankThemeWeight: 0.08,
      rankConsistencyWeight: 0.03,
      rankRawScoreWeight: 0.06,
      rankOverheatPenalty: 11,
      weighting: { minWeight: 0.06, maxWeight: 0.17 },
    },
    {
      name: "rank_benchmark_state_relative_v31",
      experimental: true,
      momentumWeight: 0.34,
      liquidityWeight: 0.18,
      stabilityWeight: 0.20,
      themeWeight: 0.28,
      minHistoryDays: 65,
      rankBlend: true,
      rankBenchmarkTrendWeight: 0.32,
      rankRelativeMomentumWeight: 0.20,
      rankMomentumWeight: 0.14,
      rankStabilityWeight: 0.14,
      rankLiquidityWeight: 0.11,
      rankThemeWeight: 0.09,
      rankRawScoreWeight: 0.06,
      rankOverheatPenalty: 9,
      weighting: { minWeight: 0.06, maxWeight: 0.16 },
    },
    {
      name: "rank_benchmark_state_attack_v32",
      experimental: true,
      momentumWeight: 0.36,
      liquidityWeight: 0.16,
      stabilityWeight: 0.18,
      themeWeight: 0.30,
      minHistoryDays: 65,
      rankBlend: true,
      rankBenchmarkTrendWeight: 0.40,
      rankRelativeMomentumWeight: 0.20,
      rankMomentumWeight: 0.08,
      rankStabilityWeight: 0.14,
      rankLiquidityWeight: 0.10,
      rankThemeWeight: 0.08,
      rankRawScoreWeight: 0.06,
      rankOverheatPenalty: 9,
      weighting: { minWeight: 0.06, maxWeight: 0.17 },
    },
    {
      name: "rank_benchmark_state_resilient_v33",
      experimental: true,
      momentumWeight: 0.32,
      liquidityWeight: 0.18,
      stabilityWeight: 0.24,
      themeWeight: 0.26,
      minHistoryDays: 65,
      rankBlend: true,
      rankBenchmarkTrendWeight: 0.32,
      rankRelativeMomentumWeight: 0.12,
      rankMomentumWeight: 0.20,
      rankStabilityWeight: 0.14,
      rankLiquidityWeight: 0.13,
      rankThemeWeight: 0.09,
      rankRawScoreWeight: 0.06,
      rankOverheatPenalty: 9,
      weighting: { minWeight: 0.06, maxWeight: 0.16 },
    },
    {
      name: "rank_52w_high_relative_v34",
      experimental: true,
      momentumWeight: 0.34,
      liquidityWeight: 0.17,
      stabilityWeight: 0.21,
      themeWeight: 0.28,
      minHistoryDays: 65,
      rankBlend: true,
      rankHigh52wWeight: 0.18,
      rankRelativeWeight: 0.28,
      rankMomentumWeight: 0.14,
      rankAccelerationWeight: 0.08,
      rankStabilityWeight: 0.14,
      rankLiquidityWeight: 0.08,
      rankThemeWeight: 0.04,
      rankConsistencyWeight: 0.02,
      rankRawScoreWeight: 0.06,
      rankOverheatPenalty: 10,
      weighting: { minWeight: 0.06, maxWeight: 0.16 },
    },
    {
      name: "rank_52w_high_attack_v35",
      experimental: true,
      momentumWeight: 0.38,
      liquidityWeight: 0.15,
      stabilityWeight: 0.17,
      themeWeight: 0.30,
      minHistoryDays: 65,
      rankBlend: true,
      rankHigh52wWeight: 0.22,
      rankRelativeWeight: 0.24,
      rankAccelerationWeight: 0.16,
      rankMomentumWeight: 0.15,
      rankStabilityWeight: 0.08,
      rankLiquidityWeight: 0.08,
      rankThemeWeight: 0.05,
      rankConsistencyWeight: 0.02,
      rankRawScoreWeight: 0.06,
      rankOverheatPenalty: 11,
      weighting: { minWeight: 0.06, maxWeight: 0.17 },
    },
    {
      name: "rank_52w_high_resilient_v36",
      experimental: true,
      momentumWeight: 0.33,
      liquidityWeight: 0.18,
      stabilityWeight: 0.24,
      themeWeight: 0.25,
      minHistoryDays: 65,
      rankBlend: true,
      rankHigh52wWeight: 0.16,
      rankRelativeWeight: 0.26,
      rankMomentumWeight: 0.18,
      rankAccelerationWeight: 0.08,
      rankStabilityWeight: 0.18,
      rankLiquidityWeight: 0.10,
      rankThemeWeight: 0.04,
      rankConsistencyWeight: 0.03,
      rankRawScoreWeight: 0.06,
      rankOverheatPenalty: 10,
      weighting: { minWeight: 0.06, maxWeight: 0.16 },
    },
    {
      name: "balanced_defensive_cash_v37",
      experimental: true,
      momentumWeight: 0.34,
      liquidityWeight: 0.24,
      stabilityWeight: 0.24,
      themeWeight: 0.18,
      minHistoryDays: 65,
      benchmarkOverlay: {
        defensiveCash: {
          enabled: true,
          maxWeight: 0.40,
        },
      },
    },
    {
      name: "rank_resilient_defensive_cash_v38",
      experimental: true,
      momentumWeight: 0.32,
      liquidityWeight: 0.18,
      stabilityWeight: 0.24,
      themeWeight: 0.26,
      minHistoryDays: 65,
      rankBlend: true,
      rankRelativeWeight: 0.26,
      rankMomentumWeight: 0.18,
      rankAccelerationWeight: 0.08,
      rankStabilityWeight: 0.18,
      rankLiquidityWeight: 0.10,
      rankThemeWeight: 0.04,
      rankConsistencyWeight: 0.03,
      rankRawScoreWeight: 0.06,
      rankOverheatPenalty: 10,
      weighting: { minWeight: 0.06, maxWeight: 0.16 },
      benchmarkOverlay: {
        defensiveCash: {
          enabled: true,
          maxWeight: 0.40,
        },
      },
    },
    {
      name: "balanced_beta_cushion_v39",
      experimental: true,
      momentumWeight: 0.34,
      liquidityWeight: 0.24,
      stabilityWeight: 0.24,
      themeWeight: 0.18,
      minHistoryDays: 65,
      benchmarkOverlay: {
        enabled: true,
        trigger20: 0.04,
        strong20: 0.16,
        trigger60: 0.12,
        strong60: 0.32,
        activation: 0.25,
        minWeight: 0.06,
        maxWeight: 0.50,
        advantageTrigger: 0.12,
        advantageFull: 0.36,
        minDampener: 0.50,
      },
    },
    {
      name: "rank_industry_residual_balanced_v40",
      experimental: true,
      momentumWeight: 0.34,
      liquidityWeight: 0.18,
      stabilityWeight: 0.22,
      themeWeight: 0.26,
      minHistoryDays: 65,
      rankBlend: true,
      rankMomentumWeight: 0.18,
      rankRelativeWeight: 0.18,
      rankIndustryWeight: 0.12,
      rankIndustryResidualWeight: 0.24,
      rankStabilityWeight: 0.14,
      rankLiquidityWeight: 0.08,
      rankThemeWeight: 0.04,
      rankConsistencyWeight: 0.02,
      rankRawScoreWeight: 0.06,
      rankOverheatPenalty: 9,
      weighting: { minWeight: 0.06, maxWeight: 0.16 },
    },
    {
      name: "rank_industry_residual_attack_v41",
      experimental: true,
      momentumWeight: 0.36,
      liquidityWeight: 0.16,
      stabilityWeight: 0.18,
      themeWeight: 0.30,
      minHistoryDays: 65,
      rankBlend: true,
      rankMomentumWeight: 0.16,
      rankAccelerationWeight: 0.14,
      rankRelativeWeight: 0.18,
      rankIndustryWeight: 0.10,
      rankIndustryResidualWeight: 0.26,
      rankStabilityWeight: 0.10,
      rankLiquidityWeight: 0.07,
      rankThemeWeight: 0.06,
      rankConsistencyWeight: 0.03,
      rankRawScoreWeight: 0.06,
      rankOverheatPenalty: 10,
      weighting: { minWeight: 0.06, maxWeight: 0.17 },
    },
    {
      name: "rank_industry_residual_beta_cushion_v42",
      experimental: true,
      momentumWeight: 0.34,
      liquidityWeight: 0.18,
      stabilityWeight: 0.22,
      themeWeight: 0.26,
      minHistoryDays: 65,
      rankBlend: true,
      rankMomentumWeight: 0.17,
      rankRelativeWeight: 0.18,
      rankIndustryWeight: 0.10,
      rankIndustryResidualWeight: 0.25,
      rankStabilityWeight: 0.13,
      rankLiquidityWeight: 0.08,
      rankThemeWeight: 0.05,
      rankConsistencyWeight: 0.04,
      rankRawScoreWeight: 0.06,
      rankOverheatPenalty: 9,
      benchmarkOverlay: {
        enabled: true,
        trigger20: 0.04,
        strong20: 0.16,
        trigger60: 0.12,
        strong60: 0.32,
        activation: 0.25,
        minWeight: 0.06,
        maxWeight: 0.50,
        advantageTrigger: 0.12,
        advantageFull: 0.36,
        minDampener: 0.50,
      },
      weighting: { minWeight: 0.06, maxWeight: 0.16 },
    },
    {
      name: "balanced_dynamic_concept_failopen_v43",
      experimental: true,
      momentumWeight: 0.34,
      liquidityWeight: 0.24,
      stabilityWeight: 0.24,
      themeWeight: 0.18,
      minHistoryDays: 65,
      universeFilter: {
        enabled: true,
        dynamicGroup: {
          enabled: true,
          groupBy: "concept",
          minGroupSize: 5,
          minGroupScore: 52,
          minBreadth20: 0.40,
        },
      },
      benchmarkOverlay: {
        enabled: true,
        trigger20: 0.04,
        strong20: 0.16,
        trigger60: 0.12,
        strong60: 0.32,
        activation: 0.25,
        minWeight: 0.06,
        maxWeight: 0.50,
        advantageTrigger: 0.12,
        advantageFull: 0.36,
        minDampener: 0.50,
      },
    },
    {
      name: "balanced_dynamic_concept_coverage_v45",
      experimental: true,
      momentumWeight: 0.34,
      liquidityWeight: 0.24,
      stabilityWeight: 0.24,
      themeWeight: 0.18,
      minHistoryDays: 65,
      universeFilter: {
        enabled: true,
        dynamicGroup: {
          enabled: true,
          groupBy: "concept",
          minGroupSize: 5,
          minGroupScore: 52,
          minBreadth20: 0.40,
          minRemainingRatio: 0.25,
        },
      },
      benchmarkOverlay: {
        enabled: true,
        trigger20: 0.04,
        strong20: 0.16,
        trigger60: 0.12,
        strong60: 0.32,
        activation: 0.25,
        minWeight: 0.06,
        maxWeight: 0.50,
        advantageTrigger: 0.12,
        advantageFull: 0.36,
        minDampener: 0.50,
      },
    },
    {
      name: "balanced_dynamic_concept_guarded_v46",
      experimental: true,
      momentumWeight: 0.34,
      liquidityWeight: 0.24,
      stabilityWeight: 0.24,
      themeWeight: 0.18,
      minHistoryDays: 65,
      universeFilter: {
        enabled: true,
        dynamicGroup: {
          enabled: true,
          groupBy: "concept",
          minGroupSize: 5,
          minGroupScore: 52,
          minBreadth20: 0.40,
          minRemainingRatio: 0.20,
        },
      },
      benchmarkOverlay: {
        enabled: true,
        trigger20: 0.04,
        strong20: 0.16,
        trigger60: 0.12,
        strong60: 0.32,
        activation: 0.25,
        minWeight: 0.06,
        maxWeight: 0.50,
        advantageTrigger: 0.12,
        advantageFull: 0.36,
        minDampener: 0.50,
      },
    },
    {
      name: "rank_dynamic_concept_strength_v47",
      experimental: true,
      momentumWeight: 0.34,
      liquidityWeight: 0.18,
      stabilityWeight: 0.22,
      themeWeight: 0.26,
      minHistoryDays: 65,
      rankBlend: true,
      dynamicGroupMetrics: {
        enabled: true,
        groupBy: "concept",
        minGroupSize: 5,
      },
      rankMomentumWeight: 0.17,
      rankRelativeWeight: 0.18,
      rankIndustryWeight: 0.08,
      rankDynamicGroupWeight: 0.20,
      rankStabilityWeight: 0.13,
      rankLiquidityWeight: 0.08,
      rankThemeWeight: 0.05,
      rankConsistencyWeight: 0.03,
      rankRawScoreWeight: 0.06,
      rankOverheatPenalty: 9,
      benchmarkOverlay: {
        enabled: true,
        trigger20: 0.04,
        strong20: 0.16,
        trigger60: 0.12,
        strong60: 0.32,
        activation: 0.25,
        minWeight: 0.06,
        maxWeight: 0.50,
        advantageTrigger: 0.12,
        advantageFull: 0.36,
        minDampener: 0.50,
      },
      weighting: { minWeight: 0.06, maxWeight: 0.16 },
    },
    {
      name: "balanced_dynamic_concept_tiebreaker_v48",
      experimental: true,
      momentumWeight: 0.34,
      liquidityWeight: 0.24,
      stabilityWeight: 0.24,
      themeWeight: 0.18,
      minHistoryDays: 65,
      dynamicGroupMetrics: {
        enabled: true,
        groupBy: "concept",
        minGroupSize: 5,
        scoreWeight: 0.06,
      },
      benchmarkOverlay: {
        enabled: true,
        trigger20: 0.04,
        strong20: 0.16,
        trigger60: 0.12,
        strong60: 0.32,
        activation: 0.25,
        minWeight: 0.06,
        maxWeight: 0.50,
        advantageTrigger: 0.12,
        advantageFull: 0.36,
        minDampener: 0.50,
      },
    },
    {
      name: "balanced_dynamic_concept_microblend_v49",
      experimental: true,
      momentumWeight: 0.34,
      liquidityWeight: 0.24,
      stabilityWeight: 0.24,
      themeWeight: 0.18,
      minHistoryDays: 65,
      dynamicGroupMetrics: {
        enabled: true,
        groupBy: "concept",
        minGroupSize: 5,
        scoreWeight: 0.03,
      },
      benchmarkOverlay: {
        enabled: true,
        trigger20: 0.04,
        strong20: 0.16,
        trigger60: 0.12,
        strong60: 0.32,
        activation: 0.25,
        minWeight: 0.06,
        maxWeight: 0.50,
        advantageTrigger: 0.12,
        advantageFull: 0.36,
        minDampener: 0.50,
      },
    },
    {
      name: "balanced_dynamic_both_microblend_v50",
      experimental: true,
      momentumWeight: 0.34,
      liquidityWeight: 0.24,
      stabilityWeight: 0.24,
      themeWeight: 0.18,
      minHistoryDays: 65,
      dynamicGroupMetrics: {
        enabled: true,
        groupBy: "both",
        minGroupSize: 5,
        scoreWeight: 0.03,
      },
      benchmarkOverlay: {
        enabled: true,
        trigger20: 0.04,
        strong20: 0.16,
        trigger60: 0.12,
        strong60: 0.32,
        activation: 0.25,
        minWeight: 0.06,
        maxWeight: 0.50,
        advantageTrigger: 0.12,
        advantageFull: 0.36,
        minDampener: 0.50,
      },
    },
    {
      name: "balanced_dynamic_source_microblend_v60",
      experimental: true,
      momentumWeight: 0.34,
      liquidityWeight: 0.24,
      stabilityWeight: 0.24,
      themeWeight: 0.18,
      minHistoryDays: 65,
      reversalScoreWeight: 0.08,
      turnoverStabilityScoreWeight: 0.04,
      dynamicGroupMetrics: {
        enabled: true,
        groupBy: "source",
        minGroupSize: 20,
        scoreWeight: 0.04,
      },
      benchmarkOverlay: {
        enabled: true,
        trigger20: 0.04,
        strong20: 0.16,
        trigger60: 0.12,
        strong60: 0.32,
        activation: 0.25,
        minWeight: 0.06,
        maxWeight: 0.50,
        advantageTrigger: 0.12,
        advantageFull: 0.36,
        minDampener: 0.50,
      },
    },
    {
      name: "balanced_reversal_stability_v51",
      experimental: true,
      momentumWeight: 0.34,
      liquidityWeight: 0.24,
      stabilityWeight: 0.24,
      themeWeight: 0.18,
      minHistoryDays: 65,
      reversalScoreWeight: 0.08,
      turnoverStabilityScoreWeight: 0.04,
      benchmarkOverlay: {
        enabled: true,
        trigger20: 0.04,
        strong20: 0.16,
        trigger60: 0.12,
        strong60: 0.32,
        activation: 0.25,
        minWeight: 0.06,
        maxWeight: 0.50,
        advantageTrigger: 0.12,
        advantageFull: 0.36,
        minDampener: 0.50,
      },
    },
    {
      name: "rank_reversal_stability_v52",
      experimental: true,
      momentumWeight: 0.34,
      liquidityWeight: 0.18,
      stabilityWeight: 0.22,
      themeWeight: 0.26,
      minHistoryDays: 65,
      rankBlend: true,
      rankMomentumWeight: 0.14,
      rankRelativeWeight: 0.16,
      rankIndustryWeight: 0.08,
      rankShortTermReversalWeight: 0.20,
      rankTurnoverStabilityWeight: 0.12,
      rankStabilityWeight: 0.13,
      rankLiquidityWeight: 0.08,
      rankThemeWeight: 0.04,
      rankConsistencyWeight: 0.03,
      rankRawScoreWeight: 0.06,
      rankOverheatPenalty: 9,
      benchmarkOverlay: {
        enabled: true,
        trigger20: 0.04,
        strong20: 0.16,
        trigger60: 0.12,
        strong60: 0.32,
        activation: 0.25,
        minWeight: 0.06,
        maxWeight: 0.50,
        advantageTrigger: 0.12,
        advantageFull: 0.36,
        minDampener: 0.50,
      },
      weighting: { minWeight: 0.06, maxWeight: 0.16 },
    },
    {
      name: "balanced_fresh_reversal_v53",
      experimental: true,
      momentumWeight: 0.34,
      liquidityWeight: 0.24,
      stabilityWeight: 0.24,
      themeWeight: 0.18,
      minHistoryDays: 65,
      freshTrendScoreWeight: 0.08,
      reversalScoreWeight: 0.07,
      turnoverStabilityScoreWeight: 0.04,
      benchmarkOverlay: {
        enabled: true,
        trigger20: 0.04,
        strong20: 0.16,
        trigger60: 0.12,
        strong60: 0.32,
        activation: 0.25,
        minWeight: 0.06,
        maxWeight: 0.50,
        advantageTrigger: 0.12,
        advantageFull: 0.36,
        minDampener: 0.50,
      },
    },
    {
      name: "rank_fresh_reversal_v54",
      experimental: true,
      momentumWeight: 0.34,
      liquidityWeight: 0.18,
      stabilityWeight: 0.22,
      themeWeight: 0.26,
      minHistoryDays: 65,
      rankBlend: true,
      rankMomentumWeight: 0.10,
      rankAccelerationWeight: 0.10,
      rankRelativeWeight: 0.14,
      rankIndustryWeight: 0.06,
      rankFreshTrendWeight: 0.22,
      rankShortTermReversalWeight: 0.14,
      rankTurnoverStabilityWeight: 0.10,
      rankStabilityWeight: 0.12,
      rankLiquidityWeight: 0.07,
      rankThemeWeight: 0.04,
      rankConsistencyWeight: 0.02,
      rankRawScoreWeight: 0.06,
      rankOverheatPenalty: 9,
      benchmarkOverlay: {
        enabled: true,
        trigger20: 0.04,
        strong20: 0.16,
        trigger60: 0.12,
        strong60: 0.32,
        activation: 0.25,
        minWeight: 0.06,
        maxWeight: 0.50,
        advantageTrigger: 0.12,
        advantageFull: 0.36,
        minDampener: 0.50,
      },
      weighting: { minWeight: 0.06, maxWeight: 0.16 },
    },
    {
      name: "rank_fresh_reversal_lottery_guard_v64",
      experimental: true,
      momentumWeight: 0.34,
      liquidityWeight: 0.18,
      stabilityWeight: 0.22,
      themeWeight: 0.26,
      minHistoryDays: 65,
      rankBlend: true,
      rankMomentumWeight: 0.09,
      rankAccelerationWeight: 0.09,
      rankRelativeWeight: 0.13,
      rankIndustryWeight: 0.05,
      rankFreshTrendWeight: 0.20,
      rankShortTermReversalWeight: 0.13,
      rankTurnoverStabilityWeight: 0.09,
      rankLotterySpikeWeight: 0.09,
      rankStabilityWeight: 0.10,
      rankLiquidityWeight: 0.06,
      rankThemeWeight: 0.04,
      rankConsistencyWeight: 0.02,
      rankRawScoreWeight: 0.06,
      rankOverheatPenalty: 9,
      benchmarkOverlay: {
        enabled: true,
        trigger20: 0.04,
        strong20: 0.16,
        trigger60: 0.12,
        strong60: 0.32,
        activation: 0.25,
        minWeight: 0.06,
        maxWeight: 0.50,
        advantageTrigger: 0.12,
        advantageFull: 0.36,
        minDampener: 0.50,
      },
      weighting: { minWeight: 0.06, maxWeight: 0.16 },
    },
    {
      name: "rank_fresh_reversal_crash_cash_v66",
      experimental: true,
      walkForwardOverlayOnly: true,
      momentumWeight: 0.34,
      liquidityWeight: 0.18,
      stabilityWeight: 0.22,
      themeWeight: 0.26,
      minHistoryDays: 65,
      rankBlend: true,
      rankMomentumWeight: 0.09,
      rankAccelerationWeight: 0.09,
      rankRelativeWeight: 0.13,
      rankIndustryWeight: 0.05,
      rankFreshTrendWeight: 0.20,
      rankShortTermReversalWeight: 0.13,
      rankTurnoverStabilityWeight: 0.09,
      rankLotterySpikeWeight: 0.09,
      rankStabilityWeight: 0.10,
      rankLiquidityWeight: 0.06,
      rankThemeWeight: 0.04,
      rankConsistencyWeight: 0.02,
      rankRawScoreWeight: 0.06,
      rankOverheatPenalty: 9,
      benchmarkOverlay: {
        enabled: true,
        trigger20: 0.04,
        strong20: 0.16,
        trigger60: 0.12,
        strong60: 0.32,
        activation: 0.25,
        minWeight: 0.06,
        maxWeight: 0.50,
        advantageTrigger: 0.12,
        advantageFull: 0.36,
        minDampener: 0.50,
        exhaustionCash: {
          enabled: true,
          freshDecayCrash: {
            enabled: true,
            minTopR20: 0.12,
            minTopR60: 0.35,
            maxFreshTrendScore: 68,
            maxShortTermReversalScore: 65,
            minTopVol20: 0.42,
            minBenchmarkR20: 0.04,
            maxBenchmarkR20: 0.10,
            minBenchmarkR60: 0.18,
            activation: 0.20,
            minWeight: 0.22,
            maxWeight: 0.55,
          },
        },
      },
      weighting: { minWeight: 0.06, maxWeight: 0.16 },
    },
    {
      name: "balanced_reversal_stability_exhaustion_cash_v55",
      experimental: true,
      momentumWeight: 0.34,
      liquidityWeight: 0.24,
      stabilityWeight: 0.24,
      themeWeight: 0.18,
      minHistoryDays: 65,
      reversalScoreWeight: 0.08,
      turnoverStabilityScoreWeight: 0.04,
      benchmarkOverlay: {
        enabled: true,
        trigger20: 0.04,
        strong20: 0.16,
        trigger60: 0.12,
        strong60: 0.32,
        activation: 0.25,
        minWeight: 0.06,
        maxWeight: 0.50,
        advantageTrigger: 0.12,
        advantageFull: 0.36,
        minDampener: 0.50,
        exhaustionCash: {
          enabled: true,
          trigger60: 0.20,
          full60: 0.35,
          max20To60Ratio: 0.35,
          ratioFull: 0.05,
          minTopR60: 0.35,
          topTrendFull: 0.65,
          minTopVol20: 0.45,
          topVolFull: 0.75,
          activation: 0.20,
          minWeight: 0.08,
          maxWeight: 0.35,
        },
      },
    },
    {
      name: "balanced_reversal_stability_selective_exhaustion_cash_v56",
      experimental: true,
      walkForwardOverlayOnly: true,
      momentumWeight: 0.34,
      liquidityWeight: 0.24,
      stabilityWeight: 0.24,
      themeWeight: 0.18,
      minHistoryDays: 65,
      reversalScoreWeight: 0.08,
      turnoverStabilityScoreWeight: 0.04,
      benchmarkOverlay: {
        enabled: true,
        trigger20: 0.04,
        strong20: 0.16,
        trigger60: 0.12,
        strong60: 0.32,
        activation: 0.25,
        minWeight: 0.06,
        maxWeight: 0.50,
        advantageTrigger: 0.12,
        advantageFull: 0.36,
        minDampener: 0.50,
        exhaustionCash: {
          enabled: true,
          trigger60: 0.20,
          full60: 0.35,
          max20To60Ratio: 0.35,
          ratioFull: 0.05,
          minTopR60: 0.35,
          topTrendFull: 0.65,
          minTopVol20: 0.45,
          topVolFull: 0.75,
          maxTopRelativeR20: 0.20,
          maxRelativeMomentumScore: 82,
          activation: 0.20,
          minWeight: 0.08,
          maxWeight: 0.35,
        },
      },
    },
    {
      name: "balanced_reversal_stability_mature_exhaustion_cash_v57",
      experimental: true,
      walkForwardOverlayOnly: true,
      momentumWeight: 0.34,
      liquidityWeight: 0.24,
      stabilityWeight: 0.24,
      themeWeight: 0.18,
      minHistoryDays: 65,
      reversalScoreWeight: 0.08,
      turnoverStabilityScoreWeight: 0.04,
      benchmarkOverlay: {
        enabled: true,
        trigger20: 0.04,
        strong20: 0.16,
        trigger60: 0.12,
        strong60: 0.32,
        activation: 0.25,
        minWeight: 0.06,
        maxWeight: 0.50,
        advantageTrigger: 0.12,
        advantageFull: 0.36,
        minDampener: 0.50,
        exhaustionCash: {
          enabled: true,
          trigger60: 0.20,
          full60: 0.35,
          max20To60Ratio: 0.35,
          ratioFull: 0.05,
          minTopR60: 0.35,
          topTrendFull: 0.65,
          minTopVol20: 0.45,
          topVolFull: 0.75,
          maxTopRelativeR20: 0.20,
          maxRelativeMomentumScore: 82,
          activation: 0.18,
          minWeight: 0.16,
          maxWeight: 0.42,
          topOnlyMaturity: {
            enabled: true,
            minTopR60: 0.65,
            topTrendFull: 0.85,
            maxAcceleration20vs60: -0.05,
            accelerationFull: -0.15,
            minTopVol20: 0.62,
            topVolFull: 0.85,
            maxFreshTrendScore: 50,
            freshFull: 35,
            minRelativeR60: 0.45,
            relativeFull: 0.75,
            activation: 0.20,
            minWeight: 0.12,
            maxWeight: 0.35,
          },
        },
      },
    },
    {
      name: "balanced_reversal_stability_mature_beta_rotation_v61",
      experimental: true,
      walkForwardOverlayOnly: true,
      momentumWeight: 0.34,
      liquidityWeight: 0.24,
      stabilityWeight: 0.24,
      themeWeight: 0.18,
      minHistoryDays: 65,
      reversalScoreWeight: 0.08,
      turnoverStabilityScoreWeight: 0.04,
      benchmarkOverlay: {
        enabled: true,
        trigger20: 0.04,
        strong20: 0.16,
        trigger60: 0.12,
        strong60: 0.32,
        activation: 0.25,
        minWeight: 0.06,
        maxWeight: 0.50,
        advantageTrigger: 0.12,
        advantageFull: 0.36,
        minDampener: 0.50,
        exhaustionCash: {
          enabled: true,
          trigger60: 0.20,
          full60: 0.35,
          max20To60Ratio: 0.35,
          ratioFull: 0.05,
          minTopR60: 0.35,
          topTrendFull: 0.65,
          minTopVol20: 0.45,
          topVolFull: 0.75,
          maxTopRelativeR20: 0.20,
          maxRelativeMomentumScore: 82,
          activation: 0.18,
          minWeight: 0.16,
          maxWeight: 0.42,
          topOnlyMaturity: {
            enabled: true,
            asBenchmarkOverlay: true,
            minTopR60: 0.65,
            topTrendFull: 0.85,
            maxAcceleration20vs60: -0.05,
            accelerationFull: -0.15,
            minTopVol20: 0.62,
            topVolFull: 0.85,
            maxFreshTrendScore: 50,
            freshFull: 35,
            minRelativeR60: 0.45,
            relativeFull: 0.75,
            activation: 0.20,
            minWeight: 0.12,
            maxWeight: 0.35,
            minBenchmarkR20ForOverlay: -0.03,
            maxBenchmarkR20ForOverlay: 0.06,
            minBenchmarkR60ForOverlay: -0.02,
            maxBenchmarkR60ForOverlay: 0.12,
          },
        },
      },
    },
    {
      name: "balanced_reversal_stability_mature_beta_rotation_stronger_v63",
      experimental: true,
      walkForwardOverlayOnly: true,
      momentumWeight: 0.34,
      liquidityWeight: 0.24,
      stabilityWeight: 0.24,
      themeWeight: 0.18,
      minHistoryDays: 65,
      reversalScoreWeight: 0.08,
      turnoverStabilityScoreWeight: 0.04,
      benchmarkOverlay: {
        enabled: true,
        trigger20: 0.04,
        strong20: 0.16,
        trigger60: 0.12,
        strong60: 0.32,
        activation: 0.25,
        minWeight: 0.06,
        maxWeight: 0.50,
        advantageTrigger: 0.12,
        advantageFull: 0.36,
        minDampener: 0.50,
        exhaustionCash: {
          enabled: true,
          trigger60: 0.20,
          full60: 0.35,
          max20To60Ratio: 0.35,
          ratioFull: 0.05,
          minTopR60: 0.35,
          topTrendFull: 0.65,
          minTopVol20: 0.45,
          topVolFull: 0.75,
          maxTopRelativeR20: 0.20,
          maxRelativeMomentumScore: 82,
          activation: 0.18,
          minWeight: 0.16,
          maxWeight: 0.42,
          topOnlyMaturity: {
            enabled: true,
            asBenchmarkOverlay: true,
            minTopR60: 0.65,
            topTrendFull: 0.85,
            maxAcceleration20vs60: -0.05,
            accelerationFull: -0.15,
            minTopVol20: 0.62,
            topVolFull: 0.85,
            maxFreshTrendScore: 50,
            freshFull: 35,
            minRelativeR60: 0.45,
            relativeFull: 0.75,
            activation: 0.20,
            minWeight: 0.18,
            maxWeight: 0.50,
            minBenchmarkR20ForOverlay: -0.03,
            maxBenchmarkR20ForOverlay: 0.06,
            minBenchmarkR60ForOverlay: -0.02,
            maxBenchmarkR60ForOverlay: 0.12,
          },
        },
      },
    },
    {
      name: "balanced_reversal_stability_mature_beta_rotation_crash_cash_v65",
      experimental: true,
      walkForwardOverlayOnly: true,
      momentumWeight: 0.34,
      liquidityWeight: 0.24,
      stabilityWeight: 0.24,
      themeWeight: 0.18,
      minHistoryDays: 65,
      reversalScoreWeight: 0.08,
      turnoverStabilityScoreWeight: 0.04,
      benchmarkOverlay: {
        enabled: true,
        trigger20: 0.04,
        strong20: 0.16,
        trigger60: 0.12,
        strong60: 0.32,
        activation: 0.25,
        minWeight: 0.06,
        maxWeight: 0.50,
        advantageTrigger: 0.12,
        advantageFull: 0.36,
        minDampener: 0.50,
        exhaustionCash: {
          enabled: true,
          trigger60: 0.20,
          full60: 0.35,
          max20To60Ratio: 0.35,
          ratioFull: 0.05,
          minTopR60: 0.35,
          topTrendFull: 0.65,
          minTopVol20: 0.45,
          topVolFull: 0.75,
          maxTopRelativeR20: 0.20,
          maxRelativeMomentumScore: 82,
          activation: 0.18,
          minWeight: 0.16,
          maxWeight: 0.42,
          topOnlyMaturity: {
            enabled: true,
            asBenchmarkOverlay: true,
            minTopR60: 0.65,
            topTrendFull: 0.85,
            maxAcceleration20vs60: -0.05,
            accelerationFull: -0.15,
            minTopVol20: 0.62,
            topVolFull: 0.85,
            maxFreshTrendScore: 50,
            freshFull: 35,
            minRelativeR60: 0.45,
            relativeFull: 0.75,
            activation: 0.20,
            minWeight: 0.18,
            maxWeight: 0.50,
            minBenchmarkR20ForOverlay: -0.03,
            maxBenchmarkR20ForOverlay: 0.06,
            minBenchmarkR60ForOverlay: -0.02,
            maxBenchmarkR60ForOverlay: 0.12,
          },
          freshDecayCrash: {
            enabled: true,
            minTopR20: 0.12,
            minTopR60: 0.35,
            maxFreshTrendScore: 68,
            maxShortTermReversalScore: 65,
            minTopVol20: 0.42,
            minBenchmarkR20: 0.04,
            maxBenchmarkR20: 0.10,
            minBenchmarkR60: 0.18,
            activation: 0.20,
            minWeight: 0.22,
            maxWeight: 0.55,
          },
        },
      },
    },
    {
      name: "balanced_reversal_stability_benchmark_pullback_catchup_v62",
      experimental: true,
      walkForwardOverlayOnly: true,
      momentumWeight: 0.34,
      liquidityWeight: 0.24,
      stabilityWeight: 0.24,
      themeWeight: 0.18,
      minHistoryDays: 65,
      reversalScoreWeight: 0.08,
      turnoverStabilityScoreWeight: 0.04,
      benchmarkOverlay: {
        pullbackCatchupOverlay: {
          enabled: true,
          minTopR60: 0.45,
          topTrendFull: 0.65,
          minFreshTrendScore: 55,
          maxFreshTrendScore: 70,
          maxBenchmarkR5: -0.01,
          fullBenchmarkR5: -0.04,
          minBenchmarkR20: 0.02,
          maxBenchmarkR20: 0.08,
          minBenchmarkR60: 0.02,
          maxBenchmarkR60: 0.12,
          benchmarkR60Full: 0.10,
          minRelativeR20: 0.18,
          relativeR20Full: 0.30,
          minRelativeMomentumScore: 90,
          maxTopVol20: 0.60,
          activation: 0.20,
          minWeight: 0.12,
          maxWeight: 0.28,
        },
      },
    },
    {
      name: "balanced_reversal_stability_beta_recovery_v58",
      experimental: true,
      walkForwardOverlayOnly: true,
      momentumWeight: 0.34,
      liquidityWeight: 0.24,
      stabilityWeight: 0.24,
      themeWeight: 0.18,
      minHistoryDays: 65,
      reversalScoreWeight: 0.08,
      turnoverStabilityScoreWeight: 0.04,
      benchmarkOverlay: {
        enabled: true,
        trigger20: -0.02,
        strong20: 0.04,
        trigger60: -0.06,
        strong60: 0.08,
        activation: 0.08,
        minWeight: 0.12,
        maxWeight: 0.42,
        advantageTrigger: 0.35,
        advantageFull: 0.65,
        minDampener: 0.80,
      },
    },
    {
      name: "balanced_reversal_stability_beta_recovery_stronger_v59",
      experimental: true,
      walkForwardOverlayOnly: true,
      momentumWeight: 0.34,
      liquidityWeight: 0.24,
      stabilityWeight: 0.24,
      themeWeight: 0.18,
      minHistoryDays: 65,
      reversalScoreWeight: 0.08,
      turnoverStabilityScoreWeight: 0.04,
      benchmarkOverlay: {
        enabled: true,
        trigger20: -0.02,
        strong20: 0.04,
        trigger60: -0.06,
        strong60: 0.08,
        activation: 0.08,
        minWeight: 0.18,
        maxWeight: 0.58,
        advantageTrigger: 0.35,
        advantageFull: 0.65,
        minDampener: 0.80,
      },
    },
    {
      name: "balanced_reversal_stability_beta_recovery_high_conviction_v67",
      experimental: true,
      walkForwardOverlayOnly: true,
      momentumWeight: 0.34,
      liquidityWeight: 0.24,
      stabilityWeight: 0.24,
      themeWeight: 0.18,
      minHistoryDays: 65,
      reversalScoreWeight: 0.08,
      turnoverStabilityScoreWeight: 0.04,
      benchmarkOverlay: {
        enabled: true,
        trigger20: -0.02,
        strong20: 0.04,
        trigger60: -0.06,
        strong60: 0.08,
        activation: 0.08,
        minWeight: 0.24,
        maxWeight: 0.85,
        advantageTrigger: 0.35,
        advantageFull: 0.65,
        minDampener: 0.84,
      },
    },
    {
      name: "balanced_dynamic_both_failopen_v44",
      experimental: true,
      momentumWeight: 0.34,
      liquidityWeight: 0.24,
      stabilityWeight: 0.24,
      themeWeight: 0.18,
      minHistoryDays: 65,
      universeFilter: {
        enabled: true,
        dynamicGroup: {
          enabled: true,
          groupBy: "both",
          minGroupSize: 5,
          minGroupScore: 52,
          minBreadth20: 0.40,
        },
      },
      benchmarkOverlay: {
        enabled: true,
        trigger20: 0.04,
        strong20: 0.16,
        trigger60: 0.12,
        strong60: 0.32,
        activation: 0.25,
        minWeight: 0.06,
        maxWeight: 0.50,
        advantageTrigger: 0.12,
        advantageFull: 0.36,
        minDampener: 0.50,
      },
    },
  ];
}

function resultObjectiveExcess(result) {
  return result?.netAdaptiveExcessVsBenchmark ?? result?.netWeightedExcessVsBenchmark ?? result?.netWeightedExcessReturn ?? result?.netExcessReturn
    ?? result?.adaptiveExcessVsBenchmark ?? result?.weightedExcessVsBenchmark ?? result?.weightedExcessReturn ?? result?.excessReturn ?? null;
}

function resultObjectiveReturn(result) {
  return result?.netAdaptiveWeightedTopReturn ?? result?.netWeightedTopReturn ?? result?.netTopMeanReturn
    ?? result?.adaptiveWeightedTopReturn ?? result?.weightedTopReturn ?? result?.topMeanReturn ?? null;
}

function downsidePenalty(values) {
  const negatives = values.filter((value) => Number.isFinite(value) && value < 0);
  if (!negatives.length) return 0;
  return Math.sqrt(mean(negatives.map((value) => value ** 2)) ?? 0);
}

function maxCumulativeDrawdown(values) {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    equity += value;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  return maxDd;
}

function recencyWeightedMean(values, decay = 0.65) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (!finite.length) return null;
  let totalWeight = 0;
  let total = 0;
  for (let i = 0; i < finite.length; i += 1) {
    const ageFromLatest = finite.length - 1 - i;
    const weight = decay ** ageFromLatest;
    totalWeight += weight;
    total += finite[i] * weight;
  }
  return total / totalWeight;
}

function walkForwardTrainingScore(trainingResults, options = {}) {
  const excessValues = trainingResults.map((result) => resultObjectiveExcess(result)).filter((value) => Number.isFinite(value));
  const returnValues = trainingResults.map((result) => resultObjectiveReturn(result)).filter((value) => Number.isFinite(value));
  if (!excessValues.length && !returnValues.length) return null;
  const avgExcess = mean(excessValues) ?? 0;
  const avgReturn = mean(returnValues) ?? 0;
  const recentWindow = options.recentWindow ?? 3;
  const recentExcess = excessValues.slice(-recentWindow);
  const recentReturn = returnValues.slice(-recentWindow);
  const recencyExcess = recencyWeightedMean(excessValues, options.recencyDecay ?? 0.65) ?? avgExcess;
  const recencyReturn = recencyWeightedMean(returnValues, options.recencyDecay ?? 0.65) ?? avgReturn;
  const hitRate = mean(excessValues.map((value) => (value > 0 ? 1 : 0))) ?? 0;
  const recentHitRate = mean(recentExcess.map((value) => (value > 0 ? 1 : 0))) ?? hitRate;
  const returnDown = downsidePenalty(recentReturn);
  const excessDown = downsidePenalty(recentExcess);
  const returnDrawdown = maxCumulativeDrawdown(returnValues);
  const latestExcess = excessValues.at(-1) ?? 0;
  const latestExcessPenalty = latestExcess < 0 ? Math.abs(latestExcess) : 0;
  return (
    avgReturn * (options.avgReturnWeight ?? 0.45) +
    avgExcess * (options.avgExcessWeight ?? 0.25) +
    recencyReturn * (options.recencyReturnWeight ?? 0.30) +
    recencyExcess * (options.recencyExcessWeight ?? 0.15) +
    hitRate * (options.hitRateWeight ?? 0.01) +
    recentHitRate * (options.recentHitRateWeight ?? 0.015) -
    returnDown * (options.returnDownsideWeight ?? 0.05) -
    excessDown * (options.excessDownsideWeight ?? 0.05) -
    returnDrawdown * (options.returnDrawdownWeight ?? 0) -
    latestExcessPenalty * (options.latestExcessLossWeight ?? 0.05)
  );
}

function isKnownBeforeAsOf(result, currentAsOf) {
  if (!currentAsOf) return true;
  const end = result?.end;
  if (!end) return false;
  return String(end) <= String(currentAsOf);
}

function currentAsOfForIndex(rowsByName, names, index) {
  for (const name of names) {
    const asOf = rowsByName.get(name)?.[index]?.asOf;
    if (asOf) return asOf;
  }
  return null;
}

function priorTrainingResultsForIndex(results, index, currentAsOf, options = {}) {
  const priorResults = (results || []).slice(0, index);
  if (!options.knownOutcomeOnly) return priorResults;
  return priorResults.filter((result) => isKnownBeforeAsOf(result, currentAsOf));
}

function optimizeParams(periodResultsByParam, holdoutIndex = null) {
  const summaries = [];
  for (const [name, results] of periodResultsByParam.entries()) {
    const training = holdoutIndex == null ? results : results.filter((_, i) => i !== holdoutIndex);
    const holdout = holdoutIndex == null ? null : results[holdoutIndex];
    const trainingExcess = training
      .map((r) => resultObjectiveExcess(r))
      .filter((x) => Number.isFinite(x));
    const trainingReturns = training
      .map((r) => resultObjectiveReturn(r))
      .filter((x) => Number.isFinite(x));
    const trainingAvgExcess = mean(trainingExcess);
    const trainingAvgReturn = mean(trainingReturns);
    const trainingHitRate = mean(trainingExcess.map((x) => (x > 0 ? 1 : 0)));
    const holdoutExcess = holdout ? resultObjectiveExcess(holdout) : null;
    const holdoutReturn = holdout ? resultObjectiveReturn(holdout) : null;
    const selectionMode = holdout ? "robust_train_holdout" : "training_avg_excess";
    const selectionScore = holdout
      ? (
        (trainingAvgReturn ?? -0.5) * 0.40 +
        (trainingAvgExcess ?? -0.5) * 0.35 +
        (holdoutReturn ?? -0.5) * 0.15 +
        (holdoutExcess ?? -0.5) * 0.10 +
        (trainingHitRate ?? 0) * 0.015 -
        Math.max(0, (trainingAvgExcess ?? 0) - (holdoutExcess ?? 0)) * 0.05 -
        downsidePenalty(trainingExcess) * 0.05
      )
      : (trainingAvgReturn ?? -0.5) * 0.50 + (trainingAvgExcess ?? -0.5) * 0.45 + (trainingHitRate ?? 0) * 0.015;
    summaries.push({
      name,
      selectionMode,
      selectionScore,
      trainingAvgReturn,
      trainingAvgExcess,
      trainingHitRate,
      holdoutExcess,
      holdoutTopReturn: holdout ? holdout.topMeanReturn : null,
      holdoutNetTopReturn: holdout ? holdout.netTopMeanReturn : null,
      holdoutWeightedTopReturn: holdout ? holdout.weightedTopReturn : null,
      holdoutNetWeightedTopReturn: holdout ? holdout.netWeightedTopReturn : null,
      holdoutAdaptiveWeightedTopReturn: holdout ? holdout.adaptiveWeightedTopReturn : null,
      holdoutNetAdaptiveWeightedTopReturn: holdout ? holdout.netAdaptiveWeightedTopReturn : null,
      holdoutDefensiveCashWeight: holdout ? holdout.defensiveCashWeight : null,
      holdoutExhaustionCashWeight: holdout ? holdout.exhaustionCashWeight : null,
      holdoutNetExcess: holdout ? resultObjectiveExcess(holdout) : null,
      holdoutUniverseReturn: holdout ? holdout.universeMeanReturn : null,
      holdoutNetUniverseReturn: holdout ? holdout.netUniverseMeanReturn : null,
      holdoutBenchmarkReturn: holdout ? holdout.benchmarkReturn : null,
      holdoutNetBenchmarkReturn: holdout ? holdout.netBenchmarkReturn : null,
      periods: results.length,
    });
  }
  summaries.sort((a, b) => (b.selectionScore ?? -Infinity) - (a.selectionScore ?? -Infinity));
  return summaries;
}

function walkForwardTrainingRows(periodResultsByParam, names, index, options = {}) {
  const currentAsOf = currentAsOfForIndex(periodResultsByParam, names, index);
  return names.map((name) => {
    const trainingResults = priorTrainingResultsForIndex(periodResultsByParam.get(name), index, currentAsOf, options);
    const trainingExcess = trainingResults.map((result) => resultObjectiveExcess(result)).filter((value) => Number.isFinite(value));
    const trainingReturns = trainingResults.map((result) => resultObjectiveReturn(result)).filter((value) => Number.isFinite(value));
    return {
      name,
      trainingAvgReturn: mean(trainingReturns),
      trainingAvgExcess: mean(trainingExcess),
      trainingHitRate: mean(trainingExcess.map((value) => (value > 0 ? 1 : 0))),
      trainingScore: walkForwardTrainingScore(trainingResults, options),
      trainingPeriods: trainingExcess.length,
      trainingReturnVol: stddev(trainingReturns),
      trainingExcessVol: stddev(trainingExcess),
      trainingReturnDownside: downsidePenalty(trainingReturns),
      trainingExcessDownside: downsidePenalty(trainingExcess),
      trainingWorstReturn: trainingReturns.length ? Math.min(...trainingReturns) : null,
      trainingWorstExcess: trainingExcess.length ? Math.min(...trainingExcess) : null,
    };
  }).sort((a, b) => (b.trainingScore ?? -Infinity) - (a.trainingScore ?? -Infinity));
}

function baseWalkForwardParamName(name) {
  return String(name || "").replace(/_top\d+$/, "");
}

function paramNameMatches(name, target) {
  if (!target) return false;
  if (name === target) return true;
  return baseWalkForwardParamName(name) === target;
}

function isExploratoryWalkForwardParam(name, options = {}) {
  const baseName = baseWalkForwardParamName(name);
  if (options.exploratoryParamNames?.includes?.(name) || options.exploratoryParamNames?.includes?.(baseName)) {
    return true;
  }
  const patterns = options.exploratoryParamPatterns || [/^rank_/];
  return patterns.some((pattern) => {
    if (pattern instanceof RegExp) return pattern.test(baseName);
    return baseName.includes(String(pattern));
  });
}

function eligibleWalkForwardTrainingRows(trainingRows, index, options = {}) {
  const exploratoryMinTrainPeriods = options.exploratoryMinTrainPeriods;
  if (!Number.isFinite(exploratoryMinTrainPeriods) || exploratoryMinTrainPeriods <= 0 || index >= exploratoryMinTrainPeriods) {
    return { rows: trainingRows, filteredParamCount: 0 };
  }
  const eligible = trainingRows.filter((row) => {
    if (paramNameMatches(row.name, options.stableParamName)) return true;
    return !isExploratoryWalkForwardParam(row.name, options);
  });
  return {
    rows: eligible.length ? eligible : trainingRows,
    filteredParamCount: trainingRows.length - (eligible.length ? eligible.length : trainingRows.length),
  };
}

function findWalkForwardTrainingRow(trainingRows, name) {
  if (!name) return null;
  return trainingRows.find((row) => row.name === name) || trainingRows.find((row) => paramNameMatches(row.name, name)) || null;
}

function selectWalkForwardTrainingRow(trainingRows, incumbentName, options = {}) {
  const candidate = trainingRows[0] || null;
  if (!candidate) return null;
  const incumbent = findWalkForwardTrainingRow(trainingRows, incumbentName);
  const margin = options.switchMargin ?? 0;
  if (!incumbent || incumbent.name === candidate.name) {
    return {
      selected: candidate,
      candidate,
      incumbent,
      candidateScoreAdvantage: incumbent ? 0 : null,
      selectionReason: incumbent ? "kept_incumbent_best" : "best_score",
    };
  }
  const candidateScore = candidate.trainingScore ?? -Infinity;
  const incumbentScore = incumbent.trainingScore ?? -Infinity;
  const candidateScoreAdvantage = candidateScore - incumbentScore;
  if (candidateScoreAdvantage < margin) {
    return {
      selected: incumbent,
      candidate,
      incumbent,
      candidateScoreAdvantage,
      selectionReason: "kept_incumbent_margin",
    };
  }
  return {
    selected: candidate,
    candidate,
    incumbent,
    candidateScoreAdvantage,
    selectionReason: "switched_margin",
  };
}

function normalizeWalkForwardCurrentBasketGate(gate) {
  if (!gate || gate === "off") return null;
  const options = gate === true || typeof gate === "string" ? { mode: gate === true ? "fresh-v1" : gate } : { ...gate };
  if (options.enabled === false || options.mode === "off") return null;
  const mode = options.mode || "fresh-v1";
  const regimeMatch = String(mode).match(/^regime-v(\d+)$/);
  const regimeNumber = regimeMatch ? Number(regimeMatch[1]) : null;
  if (mode !== "fresh-v1" && (!Number.isInteger(regimeNumber) || regimeNumber < 1 || regimeNumber > 32)) {
    return { ...options, mode };
  }
  const isRegime = Number.isInteger(regimeNumber);
  const regimeAtLeast = (value) => isRegime && regimeNumber >= value;
  const exhaustionOverlayPatterns = regimeAtLeast(7)
    ? [/mature_beta_rotation_stronger_v63/]
    : regimeAtLeast(5)
      ? [/mature_beta_rotation_v61/]
      : regimeAtLeast(2)
      ? [/mature_exhaustion_cash/]
      : [/selective_exhaustion_cash/];
  const recoveryIncumbentPatterns = regimeAtLeast(8)
    ? [/balanced_reversal_stability_v51/, /rank_benchmark_state_attack_v32/]
    : [/balanced_reversal_stability_v51/];
  return {
    candidatePatterns: [/fresh/],
    minFreshTrendAdvantage: 0,
    minR20Advantage: -0.05,
    minRelativeMomentumAdvantage: -8,
    weakFreshTrendAdvantageThreshold: 10,
    minWeakFreshR20Advantage: 0.02,
    weakFreshRequiresNegativeConfirmation: true,
    blockNegativeR20AndIndustryResidual: true,
    maxNegativeIndustryResidualAdvantage: -5,
    ...(isRegime ? {
      exhaustionOverlay: {
        enabled: true,
        incumbentPatterns: [/balanced_reversal_stability_v51/],
        overlayPatterns: exhaustionOverlayPatterns,
        minExhaustionCashWeight: 0.001,
        ...(regimeAtLeast(5) ? { minBenchmarkOverlayWeight: 0.001 } : {}),
        overlayOnly: true,
      },
    } : {}),
    ...(regimeAtLeast(3) ? {
      recoveryOverlay: {
        enabled: true,
        incumbentPatterns: recoveryIncumbentPatterns,
        overlayPatterns: mode === "regime-v3" ? [/beta_recovery_v58/] : [/beta_recovery_stronger_v59/],
        minPreviousExcess: -0.05,
        ...(regimeAtLeast(8) ? {
          relaxedPreviousExcessPatterns: [/rank_benchmark_state_attack_v32/],
          relaxedMinPreviousExcess: 0,
          useOverlayStateForRecoveryPatterns: [/rank_benchmark_state_attack_v32/],
        } : {}),
        maxCurrentBenchmarkR20: 0.02,
        maxCurrentBenchmarkR60: 0.08,
        minCurrentRelativeR20: 0.15,
        minCurrentRelativeMomentumScore: 90,
        minBenchmarkOverlayWeight: 0.05,
        overlayOnly: true,
      },
    } : {}),
    ...(regimeAtLeast(6) ? {
      pullbackCatchupOverlay: {
        enabled: true,
        incumbentPatterns: [/balanced_reversal_stability_v51/],
        overlayPatterns: [/benchmark_pullback_catchup_v62/],
        minBenchmarkOverlayWeight: 0.001,
        overlayOnly: true,
      },
    } : {}),
    ...(regimeAtLeast(9) ? {
      benchmarkStateAttackGate: {
        enabled: true,
        candidatePatterns: [/rank_benchmark_state_attack_v32/],
        minCandidateBenchmarkR20: 0.015,
        maxIndustryResidualAdvantage: -10,
        preserveRecoveryBeforeBlock: regimeAtLeast(10),
      },
    } : {}),
    ...(regimeAtLeast(11) ? {
      freshRotationOverlay: {
        enabled: true,
        incumbentPatterns: [/balanced_reversal_stability_v51/],
        overlayPatterns: [/rank_fresh_reversal_v54/],
        minFreshTrendAdvantage: 8,
        minR20Advantage: 0.05,
        minRelativeMomentumAdvantage: 4,
        maxIndustryResidualAdvantage: -8,
        minCandidateBenchmarkR20: 0.05,
        minCandidateBenchmarkR60: 0.15,
        ...(regimeAtLeast(12) ? {
          lotteryGuardOverlayPatterns: [/rank_fresh_reversal_lottery_guard_v64/],
          minLotteryGuardScore: 98,
          minLotteryGuardFreshTrendScore: 70,
          maxLotteryGuardFreshTrendScore: 82,
          lotteryGuardOverlayOnly: true,
        } : {}),
      },
    } : {}),
    ...(regimeAtLeast(13) ? {
      benchmarkPullbackAttackOverlay: {
        enabled: true,
        overlayPatterns: [/rank_benchmark_state_attack_v32/],
        minCandidateBenchmarkR20: -0.08,
        maxCandidateBenchmarkR20: -0.03,
        minCandidateBenchmarkR60: 0.05,
        maxCandidateBenchmarkR60: 0.20,
        minCandidateRelativeR20: 0.18,
        minCandidateRelativeMomentumScore: 84,
      },
    } : {}),
    ...(regimeAtLeast(14) ? {
      freshOverextensionMatureFallbackOverlay: {
        enabled: true,
        freshPatterns: [/rank_fresh_reversal_v54/],
        overlayPatterns: [/balanced_reversal_stability_mature_beta_rotation_stronger_v63/],
        minFreshTrendAdvantage: 15,
        minR20Advantage: 0.05,
        maxRelativeMomentumAdvantage: 8,
        maxIndustryResidualAdvantage: 8,
      },
    } : {}),
    ...(regimeAtLeast(15) ? {
      freshResidualContinuationOverlay: {
        enabled: true,
        incumbentPatterns: [/balanced_reversal_stability_v51/],
        overlayPatterns: [/rank_fresh_reversal_v54/],
        minCandidateFreshTrend: 66,
        maxCandidateFreshTrend: 74,
        minCandidateR20: 0.25,
        minCandidateRelativeR20: 0.24,
        minCandidateRelativeMomentumScore: 86,
        minCandidateIndustryResidualScore: 94,
        minCandidateBenchmarkR20: 0,
        maxCandidateBenchmarkR20: 0.03,
        minCandidateBenchmarkR60: 0.15,
        maxCandidateBenchmarkR60: 0.30,
      },
    } : {}),
    ...(regimeAtLeast(16) ? {
      benchmarkMeltupBroadAttackOverlay: {
        enabled: true,
        incumbentPatterns: [/balanced_reversal_stability_v51/],
        overlayPatterns: [/rank_benchmark_state_attack_v32/],
        minCandidateBenchmarkR20: 0.20,
        minCandidateBenchmarkR60: 0.35,
        minCandidateRelativeR20: 0.10,
        minCandidateRelativeMomentumScore: 68,
        minCandidateFreshTrend: 60,
        maxCandidateFreshTrend: 75,
        maxCandidateIndustryResidualRankScore: 90,
        maxCandidateLotterySpikeScore: 90,
      },
    } : {}),
    ...(regimeAtLeast(17) ? {
      benchmarkEarlyBroadAttackOverlay: {
        enabled: true,
        incumbentPatterns: [/rank_fresh_reversal_v54/],
        overlayPatterns: [/rank_benchmark_state_attack_v32/],
        minCandidateBenchmarkR20: 0.08,
        maxCandidateBenchmarkR20: 0.16,
        minCandidateBenchmarkR60: 0.10,
        maxCandidateBenchmarkR60: 0.22,
        minCandidateRelativeR20: 0.20,
        minCandidateRelativeMomentumScore: 90,
        minCandidateFreshTrend: 74,
        maxCandidateFreshTrend: 82,
        maxCandidateIndustryResidualRankScore: 82,
        maxCandidateLotterySpikeScore: 94.5,
      },
    } : {}),
    ...(regimeAtLeast(18) ? {
      freshDecayCrashOverlay: {
        enabled: true,
        freshPatterns: [/rank_fresh_reversal_v54/, /rank_fresh_reversal_lottery_guard_v64/],
        freshOverlayPatterns: [/rank_fresh_reversal_crash_cash_v66/],
        maturePatterns: [/mature_beta_rotation_stronger_v63/],
        matureOverlayPatterns: [/mature_beta_rotation_crash_cash_v65/],
        minCashWeight: 0.05,
        minSelectedBenchmarkR20: 0.04,
        maxSelectedBenchmarkR20: 0.10,
        minSelectedBenchmarkR60: 0.18,
      },
    } : {}),
    ...(regimeAtLeast(19) ? {
      pullbackBetaBoostOverlay: {
        enabled: true,
        basePatterns: [/benchmark_pullback_catchup_v62/],
        overlayPatterns: [/beta_recovery_stronger_v59/],
        minBaseBenchmarkOverlayWeight: 0.05,
        minBoostBenchmarkOverlayWeight: 0.45,
        minOverlayWeightAdvantage: 0.25,
        minCandidateBenchmarkR20: 0.02,
        maxCandidateBenchmarkR20: 0.08,
        minCandidateBenchmarkR60: 0.04,
        maxCandidateBenchmarkR60: 0.12,
        minCandidateRelativeR20: 0.18,
        minCandidateRelativeMomentumScore: 88,
        overlayOnly: true,
      },
    } : {}),
    ...(regimeAtLeast(20) ? {
      betaRecoveryHighConvictionOverlay: {
        enabled: true,
        basePatterns: [/beta_recovery_stronger_v59/],
        overlayPatterns: [/beta_recovery_high_conviction_v67/],
        minBaseBenchmarkOverlayWeight: 0.25,
        minHighConvictionBenchmarkOverlayWeight: 0.68,
        minOverlayWeightAdvantage: 0.14,
        minCandidateBenchmarkR20: -0.02,
        maxCandidateBenchmarkR20: 0.08,
        minCandidateBenchmarkR60: 0.02,
        maxCandidateBenchmarkR60: 0.14,
        minCandidateRelativeR20: 0.18,
        minCandidateRelativeMomentumScore: 90,
        overlayOnly: true,
      },
    } : {}),
    ...(regimeAtLeast(21) ? {
      directFreshLotteryGuardOverlay: {
        enabled: true,
        basePatterns: [/rank_fresh_reversal_v54/],
        overlayPatterns: [/rank_fresh_reversal_lottery_guard_v64/],
        minCandidateScoredCount: 1400,
        minCandidateFreshTrend: 55,
        maxCandidateFreshTrend: 65,
        minCandidateLotterySpikeScore: 96.5,
        minLotteryGuardScoreAdvantage: 4,
        maxCandidateMaxDailyReturn20: 0.08,
        minMaxDailyReturnReduction20: 0.02,
        maxCandidateR20: 0.18,
        overlayOnly: true,
      },
    } : {}),
    ...(regimeAtLeast(22) ? {
      freshReversalStabilityOverlay: {
        enabled: true,
        basePatterns: [/rank_fresh_reversal_v54/],
        overlayPatterns: [/rank_reversal_stability_v52/],
        minSelectedFreshTrend: 80,
        maxSelectedIndustryResidualRankScore: 80,
        minCandidateFreshTrend: 50,
        maxCandidateFreshTrend: 60,
        minCandidateRelativeMomentumScore: 90,
        minCandidateShortTermReversalScore: 72,
        minCandidateTurnoverStabilityScore: 74,
        minCandidateLotterySpikeScore: 95,
        maxCandidateMaxDailyReturn20: 0.08,
        maxCandidateVol20: 0.60,
        overlayOnly: true,
      },
    } : {}),
    ...(regimeAtLeast(23) ? {
      freshVolumeMomentumOverlay: {
        enabled: true,
        basePatterns: [/rank_fresh_reversal_v54/],
        requiredSelectionReasons: ["switched_margin"],
        overlayPatterns: [/rank_volume_momentum_balanced_v28/],
        maxSelectedFreshTrend: 65,
        maxSelectedVolumeMomentumScore: 60,
        maxSelectedR20: 0.17,
        maxSelectedRelativeMomentumScore: 88,
        minCandidateFreshTrend: 70,
        maxCandidateFreshTrend: 78,
        minCandidateVolumeMomentumScore: 70,
        maxCandidateVolumeMomentumScore: 80,
        minCandidateVolumeTurnoverRatio: 1.45,
        maxCandidateVolumeTurnoverRatio: 2.05,
        minCandidateR20: 0.18,
        maxCandidateR20: 0.25,
        minCandidateRelativeR20: 0.20,
        minCandidateRelativeMomentumScore: 92,
        maxCandidateLotterySpikeScore: 90,
        maxCandidateEntryDayReturn: 0.05,
        overlayOnly: true,
      },
    } : {}),
    ...(regimeAtLeast(24) ? {
      incumbentReversalStabilityOverlay: {
        enabled: true,
        incumbentPatterns: [/balanced_reversal_stability_v51/],
        requiredSelectionReasons: ["kept_incumbent_best", "kept_incumbent_current_gate", "kept_incumbent_margin"],
        overlayPatterns: [/rank_reversal_stability_v52/],
        minCandidateFreshTrend: 66.5,
        maxCandidateFreshTrend: 72,
        minCandidateRelativeR20: 0.20,
        maxCandidateRelativeR20: 0.25,
        minCandidateRelativeMomentumScore: 88,
        maxCandidateRelativeMomentumScore: 93,
        minCandidateIndustryResidualRankScore: 88,
        minCandidateShortTermReversalScore: 66,
        minCandidateTurnoverStabilityScore: 73,
        maxCandidateLotterySpikeScore: 92,
        maxCandidateMaxDailyReturn20: 0.10,
        maxCandidateVol20: 0.68,
        overlayOnly: true,
      },
    } : {}),
    ...(regimeAtLeast(25) ? {
      benchmarkPullbackVolumeMomentumOverlay: {
        enabled: true,
        basePatterns: [/rank_benchmark_state_attack_v32/],
        requiredSelectionReasons: ["switched_margin", "switched_current_benchmark_pullback_attack_overlay"],
        overlayPatterns: [/rank_volume_momentum_balanced_v28/],
        minCandidateBenchmarkR20: -0.035,
        maxCandidateBenchmarkR20: -0.015,
        minCandidateBenchmarkR60: 0.05,
        maxCandidateBenchmarkR60: 0.12,
        minCandidateFreshTrend: 64,
        maxCandidateFreshTrend: 72,
        minCandidateR20: 0.22,
        maxCandidateR20: 0.30,
        minCandidateRelativeR20: 0.24,
        maxCandidateRelativeR20: 0.32,
        minCandidateRelativeMomentumScore: 98,
        minCandidateIndustryResidualRankScore: 92,
        minCandidateVolumeMomentumScore: 74,
        maxCandidateVolumeMomentumScore: 82,
        minCandidateVolumeTurnoverRatio: 1.40,
        maxCandidateVolumeTurnoverRatio: 1.70,
        maxCandidateLotterySpikeScore: 87,
        maxCandidateEntryDayReturn: 0.035,
        maxCandidateMaxDailyReturn20: 0.125,
        maxCandidateVol20: 0.72,
        overlayOnly: true,
      },
    } : {}),
    ...(regimeAtLeast(26) ? {
      freshRotationReversalStabilityOverlay: {
        enabled: true,
        basePatterns: [/rank_fresh_reversal_lottery_guard_v64/],
        requiredSelectionReasons: ["switched_current_fresh_rotation_lottery_guard_overlay"],
        overlayPatterns: [/rank_reversal_stability_v52/],
        minSelectedFreshTrend: 72,
        minSelectedR20: 0.25,
        maxSelectedRelativeMomentumScore: 82,
        maxSelectedTurnoverStabilityScore: 68,
        minSelectedLotterySpikeScore: 97.5,
        minCandidateFreshTrend: 55,
        maxCandidateFreshTrend: 62,
        minCandidateRelativeR20: 0.15,
        minCandidateRelativeMomentumScore: 84,
        minCandidateIndustryResidualRankScore: 80,
        minCandidateShortTermReversalScore: 68,
        minCandidateTurnoverStabilityScore: 72,
        maxCandidateLotterySpikeScore: 88,
        maxCandidateEntryDayReturn: 0.01,
        maxCandidateMaxDailyReturn20: 0.12,
        maxCandidateVol20: 0.68,
        overlayOnly: true,
      },
    } : {}),
    ...(regimeAtLeast(27) ? {
      freshOverextensionReversalStabilityOverlay: {
        enabled: true,
        basePatterns: [/balanced_reversal_stability_mature_beta_rotation_stronger_v63/],
        requiredSelectionReasons: ["switched_current_fresh_overextension_mature_fallback_overlay"],
        overlayPatterns: [/rank_reversal_stability_v52/],
        minCandidateBenchmarkR20: -0.005,
        maxCandidateBenchmarkR20: 0.015,
        minCandidateBenchmarkR60: -0.08,
        maxCandidateBenchmarkR60: -0.03,
        minCandidateFreshTrend: 52,
        maxCandidateFreshTrend: 60,
        minCandidateR20: 0.12,
        maxCandidateR20: 0.20,
        minCandidateRelativeR20: 0.12,
        maxCandidateRelativeR20: 0.19,
        minCandidateRelativeMomentumScore: 75,
        maxCandidateRelativeMomentumScore: 86,
        minCandidateIndustryResidualRankScore: 68,
        maxCandidateIndustryResidualRankScore: 75,
        minCandidateShortTermReversalScore: 65,
        minCandidateTurnoverStabilityScore: 70,
        minCandidateLotterySpikeScore: 98,
        maxCandidateEntryDayReturn: 0.02,
        maxCandidateMaxDailyReturn20: 0.06,
        maxCandidateVol20: 0.42,
        maxCandidateVolumeMomentumScore: 55,
        overlayOnly: true,
      },
    } : {}),
    ...(regimeAtLeast(28) ? {
      benchmarkPullbackResidualVolumeMomentumOverlay: {
        enabled: true,
        basePatterns: [/rank_benchmark_state_attack_v32/],
        requiredSelectionReasons: ["switched_current_benchmark_pullback_attack_overlay"],
        overlayPatterns: [/rank_volume_momentum_balanced_v28/],
        minCandidateBenchmarkR20: -0.04,
        maxCandidateBenchmarkR20: -0.02,
        minCandidateBenchmarkR60: 0.04,
        maxCandidateBenchmarkR60: 0.08,
        minCandidateFreshTrend: 73,
        maxCandidateFreshTrend: 82,
        minCandidateR20: 0.21,
        maxCandidateR20: 0.28,
        minCandidateRelativeR20: 0.24,
        maxCandidateRelativeR20: 0.30,
        minCandidateRelativeMomentumScore: 90,
        maxCandidateRelativeMomentumScore: 95,
        minCandidateIndustryResidualRankScore: 94,
        minCandidateVolumeMomentumScore: 74,
        maxCandidateVolumeMomentumScore: 82,
        minCandidateVolumeTurnoverRatio: 1.70,
        maxCandidateVolumeTurnoverRatio: 2.05,
        maxCandidateLotterySpikeScore: 82,
        maxCandidateEntryDayReturn: 0.02,
        maxCandidateMaxDailyReturn20: 0.14,
        maxCandidateVol20: 0.80,
        overlayOnly: true,
      },
    } : {}),
    ...(regimeAtLeast(29) ? {
      broadPoolReversalStabilityOverlay: {
        enabled: true,
        incumbentPatterns: [/balanced_reversal_stability_v51/],
        requiredSelectionReasons: ["kept_incumbent_best", "kept_incumbent_current_gate", "kept_incumbent_margin"],
        overlayPatterns: [/rank_reversal_stability_v52/],
        minCandidateScoredCount: 1500,
        minCandidateBenchmarkR20: 0.02,
        maxCandidateBenchmarkR20: 0.05,
        minCandidateBenchmarkR60: -0.04,
        maxCandidateBenchmarkR60: 0,
        minCandidateFreshTrend: 58,
        maxCandidateFreshTrend: 66,
        minCandidateR20: 0.16,
        maxCandidateR20: 0.23,
        minCandidateRelativeR20: 0.14,
        maxCandidateRelativeR20: 0.18,
        minCandidateRelativeMomentumScore: 88,
        maxCandidateRelativeMomentumScore: 92,
        minCandidateIndustryResidualRankScore: 82,
        minCandidateShortTermReversalScore: 68,
        minCandidateTurnoverStabilityScore: 72,
        minCandidateVolumeMomentumScore: 60,
        maxCandidateVolumeMomentumScore: 72,
        maxCandidateLotterySpikeScore: 96,
        maxCandidateEntryDayReturn: 0.025,
        maxCandidateMaxDailyReturn20: 0.085,
        maxCandidateVol20: 0.58,
        minCandidateIndustryBreadth20: 0.70,
        overlayOnly: true,
      },
    } : {}),
    ...(regimeAtLeast(30) ? {
      benchmarkPullbackReversalStabilityOverlay: {
        enabled: true,
        incumbentPatterns: [/rank_benchmark_state_attack_v32/],
        requiredSelectionReasons: ["switched_current_benchmark_pullback_attack_overlay"],
        overlayPatterns: [/rank_reversal_stability_v52/],
        minCandidateScoredCount: 1500,
        minCandidateBenchmarkR20: -0.05,
        maxCandidateBenchmarkR20: -0.035,
        minCandidateBenchmarkR60: 0.045,
        maxCandidateBenchmarkR60: 0.08,
        minCandidateFreshTrend: 35,
        maxCandidateFreshTrend: 50,
        minCandidateR20: 0.10,
        maxCandidateR20: 0.15,
        minCandidateRelativeR20: 0.15,
        maxCandidateRelativeR20: 0.19,
        minCandidateRelativeMomentumScore: 88,
        minCandidateIndustryResidualRankScore: 80,
        minCandidateShortTermReversalScore: 64,
        minCandidateTurnoverStabilityScore: 66,
        maxCandidateVolumeMomentumScore: 55,
        maxCandidateLotterySpikeScore: 98,
        maxCandidateEntryDayReturn: 0.015,
        maxCandidateMaxDailyReturn20: 0.08,
        maxCandidateVol20: 0.50,
        minCandidateIndustryBreadth20: 0.50,
        overlayOnly: true,
      },
    } : {}),
    ...(regimeAtLeast(31) ? {
      broadPoolVolumeMomentumOverlay: {
        enabled: true,
        basePatterns: [/balanced_reversal_stability_v51/],
        requiredSelectionReasons: ["kept_incumbent_best", "kept_incumbent_current_gate", "kept_incumbent_margin"],
        overlayPatterns: [/rank_volume_momentum_balanced_v28/],
        minCandidateScoredCount: 1500,
        minCandidateBenchmarkR20: 0.03,
        maxCandidateBenchmarkR20: 0.045,
        minCandidateBenchmarkR60: -0.01,
        maxCandidateBenchmarkR60: 0.03,
        minCandidateFreshTrend: 84,
        maxCandidateFreshTrend: 90,
        minCandidateR20: 0.33,
        maxCandidateR20: 0.39,
        minCandidateRelativeR20: 0.30,
        maxCandidateRelativeR20: 0.34,
        minCandidateRelativeMomentumScore: 95,
        minCandidateIndustryResidualRankScore: 82,
        minCandidateVolumeMomentumScore: 82,
        maxCandidateVolumeMomentumScore: 86,
        minCandidateVolumeTurnoverRatio: 1.40,
        maxCandidateVolumeTurnoverRatio: 1.60,
        maxCandidateLotterySpikeScore: 92,
        maxCandidateEntryDayReturn: 0.02,
        maxCandidateMaxDailyReturn20: 0.11,
        maxCandidateVol20: 0.56,
        minCandidateIndustryBreadth20: 0.90,
        overlayOnly: true,
      },
    } : {}),
    ...(regimeAtLeast(32) ? {
      narrowNoStaticMeltupOverlay: {
        enabled: true,
        basePatterns: [/balanced_reversal_stability_v51/],
        requiredSelectionReasons: ["kept_incumbent_best", "kept_incumbent_current_gate", "kept_incumbent_margin"],
        overlayPatterns: [/balanced_reversal_stability_mature_beta_rotation_stronger_v63_no_static_theme/],
        maxCandidateScoredCount: 1300,
        minCandidateBenchmarkR20: 0.03,
        maxCandidateBenchmarkR20: 0.055,
        minCandidateBenchmarkR60: 0,
        maxCandidateBenchmarkR60: 0.08,
        minCandidateFreshTrend: 64,
        maxCandidateFreshTrend: 72,
        minCandidateR20: 0.22,
        maxCandidateR20: 0.33,
        minCandidateRelativeR20: 0.18,
        maxCandidateRelativeR20: 0.28,
        minCandidateRelativeMomentumScore: 88,
        maxCandidateRelativeMomentumScore: 94,
        minCandidateVolumeMomentumScore: 70,
        maxCandidateVolumeMomentumScore: 78,
        minCandidateVolumeTurnoverRatio: 1.45,
        maxCandidateVolumeTurnoverRatio: 1.65,
        maxCandidateLotterySpikeScore: 94,
        minCandidateEntryDayReturn: -0.025,
        maxCandidateEntryDayReturn: 0.015,
        maxCandidateMaxDailyReturn20: 0.10,
        maxCandidateVol20: 0.53,
        overlayOnly: true,
      },
    } : {}),
    ...options,
    mode,
  };
}

function walkForwardPatternMatches(name, patterns = []) {
  const baseName = baseWalkForwardParamName(name);
  return patterns.some((pattern) => {
    if (pattern instanceof RegExp) return pattern.test(baseName) || pattern.test(name);
    return baseName.includes(String(pattern)) || String(name || "").includes(String(pattern));
  });
}

function basketMetricAverage(result, fields) {
  const fieldNames = Array.isArray(fields) ? fields : [fields];
  const values = [];
  for (const row of result?.top || []) {
    for (const field of fieldNames) {
      const value = Number(row?.[field]);
      if (Number.isFinite(value)) {
        values.push(value);
        break;
      }
    }
  }
  return mean(values);
}

function walkForwardCurrentBasketMetrics(candidateResult, incumbentResult) {
  const candidateFresh = basketMetricAverage(candidateResult, "freshTrendScore");
  const incumbentFresh = basketMetricAverage(incumbentResult, "freshTrendScore");
  const candidateR20 = basketMetricAverage(candidateResult, "r20");
  const incumbentR20 = basketMetricAverage(incumbentResult, "r20");
  const candidateRelative = basketMetricAverage(candidateResult, "relativeMomentumScore");
  const incumbentRelative = basketMetricAverage(incumbentResult, "relativeMomentumScore");
  const candidateIndustryResidual = basketMetricAverage(candidateResult, ["industryResidualMomentumScore", "industryResidualR20Score"]);
  const incumbentIndustryResidual = basketMetricAverage(incumbentResult, ["industryResidualMomentumScore", "industryResidualR20Score"]);
  const candidateIndustryResidualRank = basketMetricAverage(candidateResult, "industryResidualRankScore");
  const incumbentIndustryResidualRank = basketMetricAverage(incumbentResult, "industryResidualRankScore");
  return {
    candidateFreshTrend: candidateFresh,
    incumbentFreshTrend: incumbentFresh,
    freshTrendAdvantage: Number.isFinite(candidateFresh) && Number.isFinite(incumbentFresh) ? candidateFresh - incumbentFresh : null,
    candidateR20,
    incumbentR20,
    r20Advantage: Number.isFinite(candidateR20) && Number.isFinite(incumbentR20) ? candidateR20 - incumbentR20 : null,
    candidateRelativeMomentum: candidateRelative,
    incumbentRelativeMomentum: incumbentRelative,
    relativeMomentumAdvantage: Number.isFinite(candidateRelative) && Number.isFinite(incumbentRelative) ? candidateRelative - incumbentRelative : null,
    candidateIndustryResidual: candidateIndustryResidual,
    incumbentIndustryResidual: incumbentIndustryResidual,
    candidateIndustryResidualRank,
    incumbentIndustryResidualRank,
    industryResidualAdvantage: Number.isFinite(candidateIndustryResidual) && Number.isFinite(incumbentIndustryResidual)
      ? candidateIndustryResidual - incumbentIndustryResidual
      : null,
    industryResidualRankAdvantage: Number.isFinite(candidateIndustryResidualRank) && Number.isFinite(incumbentIndustryResidualRank)
      ? candidateIndustryResidualRank - incumbentIndustryResidualRank
      : null,
  };
}

function evaluateWalkForwardCurrentBasketGate(decision, periodResultsByParam, index, options = {}) {
  const gate = normalizeWalkForwardCurrentBasketGate(options.currentBasketGate);
  if (!gate || !decision?.candidate || !decision?.incumbent) return null;
  if (decision.selected?.name !== decision.candidate.name || decision.candidate.name === decision.incumbent.name) return null;
  const matchesFreshGate = walkForwardPatternMatches(decision.candidate.name, gate.candidatePatterns || []);
  const attackGate = gate.benchmarkStateAttackGate;
  const matchesAttackGate = attackGate?.enabled && walkForwardPatternMatches(decision.candidate.name, attackGate.candidatePatterns || []);
  if (!matchesFreshGate && !matchesAttackGate) return null;
  const candidateResult = periodResultsByParam.get(decision.candidate.name)?.[index];
  const incumbentResult = periodResultsByParam.get(decision.incumbent.name)?.[index];
  const metrics = walkForwardCurrentBasketMetrics(candidateResult, incumbentResult);
  const reasons = [];
  const relativeMomentumAdvantage = metrics.relativeMomentumAdvantage;
  const freshTrendAdvantage = metrics.freshTrendAdvantage;
  const r20Advantage = metrics.r20Advantage;
  const industryResidualAdvantage = metrics.industryResidualAdvantage;
  if (matchesAttackGate && !matchesFreshGate) {
    const candidateBenchmarkR20 = basketMetricAverage(candidateResult, "benchmarkR20");
    if (
      Number.isFinite(candidateBenchmarkR20) &&
      Number.isFinite(industryResidualAdvantage) &&
      candidateBenchmarkR20 >= (attackGate.minCandidateBenchmarkR20 ?? 0.015) &&
      industryResidualAdvantage <= (attackGate.maxIndustryResidualAdvantage ?? -10)
    ) {
      reasons.push("attack_benchmark_positive_industry_residual_advantage_below_min");
    }
    return {
      mode: gate.mode,
      passed: reasons.length === 0,
      reason: reasons.join("|") || "passed",
      candidateBenchmarkR20,
      ...metrics,
    };
  }
  if (Number.isFinite(relativeMomentumAdvantage) && relativeMomentumAdvantage < gate.minRelativeMomentumAdvantage) {
    reasons.push("relative_momentum_advantage_below_min");
  }
  if (Number.isFinite(freshTrendAdvantage) && freshTrendAdvantage < gate.minFreshTrendAdvantage) {
    reasons.push("fresh_trend_advantage_below_min");
  }
  if (Number.isFinite(r20Advantage) && r20Advantage < gate.minR20Advantage) {
    reasons.push("r20_advantage_below_min");
  }
  if (
    Number.isFinite(freshTrendAdvantage) &&
    Number.isFinite(r20Advantage) &&
    Number.isFinite(gate.weakFreshTrendAdvantageThreshold) &&
    Number.isFinite(gate.minWeakFreshR20Advantage) &&
    freshTrendAdvantage < gate.weakFreshTrendAdvantageThreshold &&
    r20Advantage < gate.minWeakFreshR20Advantage &&
    (
      !gate.weakFreshRequiresNegativeConfirmation ||
      (Number.isFinite(relativeMomentumAdvantage) && relativeMomentumAdvantage < 0) ||
      (Number.isFinite(industryResidualAdvantage) && industryResidualAdvantage < 0)
    )
  ) {
    reasons.push("weak_fresh_trend_needs_r20_confirmation");
  }
  if (
    gate.blockNegativeR20AndIndustryResidual &&
    Number.isFinite(r20Advantage) &&
    Number.isFinite(industryResidualAdvantage) &&
    r20Advantage < 0 &&
    industryResidualAdvantage <= gate.maxNegativeIndustryResidualAdvantage
  ) {
    reasons.push("negative_r20_and_industry_residual_advantage");
  }
  return {
    mode: gate.mode,
    passed: reasons.length === 0,
    reason: reasons.join("|") || "passed",
    ...metrics,
  };
}

function applyWalkForwardCurrentBasketGate(decision, periodResultsByParam, index, options = {}) {
  return applyWalkForwardCurrentBasketGateWithRows(decision, periodResultsByParam, index, options);
}

function findWalkForwardOverlayRow(trainingRows, selectedName, overlayPatterns = []) {
  return trainingRows.find((row) => row.name !== selectedName && walkForwardPatternMatches(row.name, overlayPatterns));
}

function evaluateWalkForwardExhaustionOverlay(decision, periodResultsByParam, index, options = {}, trainingRows = []) {
  const gate = normalizeWalkForwardCurrentBasketGate(options.currentBasketGate);
  const overlay = gate?.exhaustionOverlay;
  if (!overlay?.enabled || !decision?.selected) return null;
  if (!walkForwardPatternMatches(decision.selected.name, overlay.incumbentPatterns || [])) return null;
  const overlayRow = findWalkForwardOverlayRow(trainingRows, decision.selected.name, overlay.overlayPatterns || []);
  if (!overlayRow) return null;
  const overlayResult = periodResultsByParam.get(overlayRow.name)?.[index];
  const exhaustionCashWeight = Number(overlayResult?.exhaustionCashWeight);
  const benchmarkOverlayWeight = Number(overlayResult?.benchmarkOverlayWeight);
  const cashTriggered = Number.isFinite(exhaustionCashWeight) && exhaustionCashWeight >= (overlay.minExhaustionCashWeight ?? 0.001);
  const benchmarkTriggered = Number.isFinite(overlay.minBenchmarkOverlayWeight) &&
    Number.isFinite(benchmarkOverlayWeight) &&
    benchmarkOverlayWeight >= overlay.minBenchmarkOverlayWeight;
  if (!cashTriggered && !benchmarkTriggered) return null;
  return {
    mode: gate.mode,
    passed: true,
    reason: "exhaustion_overlay_applied",
    overlayRow,
    exhaustionCashWeight: Number.isFinite(exhaustionCashWeight) ? exhaustionCashWeight : 0,
    benchmarkOverlayWeight: Number.isFinite(benchmarkOverlayWeight) ? benchmarkOverlayWeight : 0,
  };
}

function evaluateWalkForwardFreshRotationOverlay(decision, periodResultsByParam, index, options = {}, trainingRows = []) {
  const gate = normalizeWalkForwardCurrentBasketGate(options.currentBasketGate);
  const overlay = gate?.freshRotationOverlay;
  if (!overlay?.enabled || !decision?.selected) return null;
  if (!walkForwardPatternMatches(decision.selected.name, overlay.incumbentPatterns || [])) return null;
  const overlayRow = findWalkForwardOverlayRow(trainingRows, decision.selected.name, overlay.overlayPatterns || []);
  if (!overlayRow) return null;
  const candidateResult = periodResultsByParam.get(overlayRow.name)?.[index];
  const incumbentResult = periodResultsByParam.get(decision.selected.name)?.[index];
  const metrics = walkForwardCurrentBasketMetrics(candidateResult, incumbentResult);
  const candidateBenchmarkR20 = basketMetricAverage(candidateResult, "benchmarkR20");
  const candidateBenchmarkR60 = basketMetricAverage(candidateResult, "benchmarkR60");
  if (!Number.isFinite(metrics.freshTrendAdvantage) || metrics.freshTrendAdvantage < (overlay.minFreshTrendAdvantage ?? 8)) return null;
  if (!Number.isFinite(metrics.r20Advantage) || metrics.r20Advantage < (overlay.minR20Advantage ?? 0.05)) return null;
  if (!Number.isFinite(metrics.relativeMomentumAdvantage) || metrics.relativeMomentumAdvantage < (overlay.minRelativeMomentumAdvantage ?? 4)) return null;
  if (!Number.isFinite(metrics.industryResidualAdvantage) || metrics.industryResidualAdvantage > (overlay.maxIndustryResidualAdvantage ?? -8)) return null;
  if (!Number.isFinite(candidateBenchmarkR20) || candidateBenchmarkR20 < (overlay.minCandidateBenchmarkR20 ?? 0.05)) return null;
  if (!Number.isFinite(candidateBenchmarkR60) || candidateBenchmarkR60 < (overlay.minCandidateBenchmarkR60 ?? 0.15)) return null;
  const lotteryGuardRow = findWalkForwardOverlayRow(trainingRows, overlayRow.name, overlay.lotteryGuardOverlayPatterns || []);
  if (lotteryGuardRow) {
    const lotteryGuardResult = periodResultsByParam.get(lotteryGuardRow.name)?.[index];
    const lotteryGuardScore = basketMetricAverage(lotteryGuardResult, "lotterySpikeScore");
    const lotteryGuardFreshTrend = basketMetricAverage(lotteryGuardResult, "freshTrendScore");
    if (
      Number.isFinite(lotteryGuardScore) &&
      lotteryGuardScore >= (overlay.minLotteryGuardScore ?? 98) &&
      Number.isFinite(lotteryGuardFreshTrend) &&
      lotteryGuardFreshTrend >= (overlay.minLotteryGuardFreshTrendScore ?? 70) &&
      lotteryGuardFreshTrend <= (overlay.maxLotteryGuardFreshTrendScore ?? 82)
    ) {
      return {
        mode: gate.mode,
        passed: true,
        reason: "fresh_rotation_lottery_guard_overlay_applied",
        overlayRow: lotteryGuardRow,
        candidateBenchmarkR20,
        candidateBenchmarkR60,
        lotteryGuardScore,
        lotteryGuardFreshTrend,
        ...metrics,
      };
    }
  }
  return {
    mode: gate.mode,
    passed: true,
    reason: "fresh_rotation_overlay_applied",
    overlayRow,
    candidateBenchmarkR20,
    candidateBenchmarkR60,
    ...metrics,
  };
}

function evaluateWalkForwardRecoveryOverlay(decision, periodResultsByParam, index, options = {}, trainingRows = [], selections = []) {
  const gate = normalizeWalkForwardCurrentBasketGate(options.currentBasketGate);
  const overlay = gate?.recoveryOverlay;
  if (!overlay?.enabled || !decision?.selected) return null;
  if (!walkForwardPatternMatches(decision.selected.name, overlay.incumbentPatterns || [])) return null;
  const previousSelection = selections.at(-1);
  const previous = previousSelection?.periodIndex === index - 1
    ? previousSelection
    : periodResultsByParam.get(decision.selected.name)?.[index - 1];
  const previousExcess = Number(previous?.netAdaptiveExcessVsBenchmark);
  const minPreviousExcess = walkForwardPatternMatches(decision.selected.name, overlay.relaxedPreviousExcessPatterns || [])
    ? (overlay.relaxedMinPreviousExcess ?? overlay.minPreviousExcess ?? -0.05)
    : (overlay.minPreviousExcess ?? -0.05);
  if (!Number.isFinite(previousExcess) || previousExcess > minPreviousExcess) return null;

  const overlayRow = findWalkForwardOverlayRow(trainingRows, decision.selected.name, overlay.overlayPatterns || []);
  if (!overlayRow) return null;
  const overlayResult = periodResultsByParam.get(overlayRow.name)?.[index];
  const useOverlayState = walkForwardPatternMatches(decision.selected.name, overlay.useOverlayStateForRecoveryPatterns || []);
  const stateResult = useOverlayState
    ? overlayResult
    : periodResultsByParam.get(decision.selected.name)?.[index];
  const currentBenchmarkR20 = basketMetricAverage(stateResult, "benchmarkR20");
  const currentBenchmarkR60 = basketMetricAverage(stateResult, "benchmarkR60");
  const currentRelativeR20 = basketMetricAverage(stateResult, "relativeR20");
  const currentRelativeMomentum = basketMetricAverage(stateResult, "relativeMomentumScore");
  if (!Number.isFinite(currentBenchmarkR20) || currentBenchmarkR20 > (overlay.maxCurrentBenchmarkR20 ?? 0.02)) return null;
  if (!Number.isFinite(currentBenchmarkR60) || currentBenchmarkR60 > (overlay.maxCurrentBenchmarkR60 ?? 0.08)) return null;
  if (!Number.isFinite(currentRelativeR20) || currentRelativeR20 < (overlay.minCurrentRelativeR20 ?? 0.15)) return null;
  if (
    Number.isFinite(overlay.minCurrentRelativeMomentumScore) &&
    (!Number.isFinite(currentRelativeMomentum) || currentRelativeMomentum < overlay.minCurrentRelativeMomentumScore)
  ) return null;

  const benchmarkOverlayWeight = Number(overlayResult?.benchmarkOverlayWeight);
  if (!Number.isFinite(benchmarkOverlayWeight) || benchmarkOverlayWeight < (overlay.minBenchmarkOverlayWeight ?? 0.05)) return null;
  return {
    mode: gate.mode,
    passed: true,
    reason: "recovery_overlay_applied",
    overlayRow,
    benchmarkOverlayWeight,
    previousExcess,
    currentBenchmarkR20,
    currentBenchmarkR60,
    currentRelativeR20,
    currentRelativeMomentum,
  };
}

function evaluateWalkForwardPullbackCatchupOverlay(decision, periodResultsByParam, index, options = {}, trainingRows = []) {
  const gate = normalizeWalkForwardCurrentBasketGate(options.currentBasketGate);
  const overlay = gate?.pullbackCatchupOverlay;
  if (!overlay?.enabled || !decision?.selected) return null;
  if (!walkForwardPatternMatches(decision.selected.name, overlay.incumbentPatterns || [])) return null;
  const overlayRow = findWalkForwardOverlayRow(trainingRows, decision.selected.name, overlay.overlayPatterns || []);
  if (!overlayRow) return null;
  const overlayResult = periodResultsByParam.get(overlayRow.name)?.[index];
  const benchmarkOverlayWeight = Number(overlayResult?.benchmarkOverlayWeight);
  if (!Number.isFinite(benchmarkOverlayWeight) || benchmarkOverlayWeight < (overlay.minBenchmarkOverlayWeight ?? 0.001)) return null;
  return {
    mode: gate.mode,
    passed: true,
    reason: "pullback_catchup_overlay_applied",
    overlayRow,
    benchmarkOverlayWeight,
  };
}

function evaluateWalkForwardPullbackBetaBoostOverlay(decision, periodResultsByParam, index, options = {}, trainingRows = []) {
  const gate = normalizeWalkForwardCurrentBasketGate(options.currentBasketGate);
  const overlay = gate?.pullbackBetaBoostOverlay;
  if (!overlay?.enabled || !decision?.selected) return null;
  if (!walkForwardPatternMatches(decision.selected.name, overlay.basePatterns || [])) return null;
  const baseResult = periodResultsByParam.get(decision.selected.name)?.[index];
  const baseBenchmarkOverlayWeight = Number(baseResult?.benchmarkOverlayWeight);
  if (!Number.isFinite(baseBenchmarkOverlayWeight) || baseBenchmarkOverlayWeight < (overlay.minBaseBenchmarkOverlayWeight ?? 0.05)) return null;

  const candidateBenchmarkR20 = basketMetricAverage(baseResult, "benchmarkR20");
  const candidateBenchmarkR60 = basketMetricAverage(baseResult, "benchmarkR60");
  const candidateRelativeR20 = basketMetricAverage(baseResult, "relativeR20");
  const candidateRelativeMomentum = basketMetricAverage(baseResult, "relativeMomentumScore");
  if (!Number.isFinite(candidateBenchmarkR20) || candidateBenchmarkR20 < (overlay.minCandidateBenchmarkR20 ?? 0.02)) return null;
  if (Number.isFinite(overlay.maxCandidateBenchmarkR20) && candidateBenchmarkR20 > overlay.maxCandidateBenchmarkR20) return null;
  if (!Number.isFinite(candidateBenchmarkR60) || candidateBenchmarkR60 < (overlay.minCandidateBenchmarkR60 ?? 0.04)) return null;
  if (Number.isFinite(overlay.maxCandidateBenchmarkR60) && candidateBenchmarkR60 > overlay.maxCandidateBenchmarkR60) return null;
  if (!Number.isFinite(candidateRelativeR20) || candidateRelativeR20 < (overlay.minCandidateRelativeR20 ?? 0.18)) return null;
  if (
    Number.isFinite(overlay.minCandidateRelativeMomentumScore) &&
    (!Number.isFinite(candidateRelativeMomentum) || candidateRelativeMomentum < overlay.minCandidateRelativeMomentumScore)
  ) return null;

  const overlayRow = findWalkForwardOverlayRow(trainingRows, decision.selected.name, overlay.overlayPatterns || []);
  if (!overlayRow) return null;
  const overlayResult = periodResultsByParam.get(overlayRow.name)?.[index];
  const boostBenchmarkOverlayWeight = Number(overlayResult?.benchmarkOverlayWeight);
  if (!Number.isFinite(boostBenchmarkOverlayWeight) || boostBenchmarkOverlayWeight < (overlay.minBoostBenchmarkOverlayWeight ?? 0.45)) return null;
  if (boostBenchmarkOverlayWeight - baseBenchmarkOverlayWeight < (overlay.minOverlayWeightAdvantage ?? 0.25)) return null;
  return {
    mode: gate.mode,
    passed: true,
    reason: "pullback_beta_boost_overlay_applied",
    overlayRow,
    benchmarkOverlayWeight: boostBenchmarkOverlayWeight,
    baseBenchmarkOverlayWeight,
    candidateBenchmarkR20,
    candidateBenchmarkR60,
    candidateRelativeR20,
    candidateRelativeMomentum,
  };
}

function applyWalkForwardPullbackBetaBoostOverlay(decision, periodResultsByParam, index, options = {}, trainingRows = []) {
  const betaBoostResult = evaluateWalkForwardPullbackBetaBoostOverlay(decision, periodResultsByParam, index, options, trainingRows);
  if (!betaBoostResult) return null;
  return {
    decision: {
      ...decision,
      selected: betaBoostResult.overlayRow,
      selectionReason: "switched_current_pullback_beta_boost_overlay",
    },
    gateResult: betaBoostResult,
  };
}

function evaluateWalkForwardBetaRecoveryHighConvictionOverlay(decision, periodResultsByParam, index, options = {}, trainingRows = []) {
  const gate = normalizeWalkForwardCurrentBasketGate(options.currentBasketGate);
  const overlay = gate?.betaRecoveryHighConvictionOverlay;
  if (!overlay?.enabled || !decision?.selected) return null;
  if (!walkForwardPatternMatches(decision.selected.name, overlay.basePatterns || [])) return null;

  const baseResult = periodResultsByParam.get(decision.selected.name)?.[index];
  const baseBenchmarkOverlayWeight = Number(baseResult?.benchmarkOverlayWeight);
  if (!Number.isFinite(baseBenchmarkOverlayWeight) || baseBenchmarkOverlayWeight < (overlay.minBaseBenchmarkOverlayWeight ?? 0.25)) return null;

  const candidateBenchmarkR20 = basketMetricAverage(baseResult, "benchmarkR20");
  const candidateBenchmarkR60 = basketMetricAverage(baseResult, "benchmarkR60");
  const candidateRelativeR20 = basketMetricAverage(baseResult, "relativeR20");
  const candidateRelativeMomentum = basketMetricAverage(baseResult, "relativeMomentumScore");
  if (!Number.isFinite(candidateBenchmarkR20) || candidateBenchmarkR20 < (overlay.minCandidateBenchmarkR20 ?? -0.02)) return null;
  if (Number.isFinite(overlay.maxCandidateBenchmarkR20) && candidateBenchmarkR20 > overlay.maxCandidateBenchmarkR20) return null;
  if (!Number.isFinite(candidateBenchmarkR60) || candidateBenchmarkR60 < (overlay.minCandidateBenchmarkR60 ?? 0.02)) return null;
  if (Number.isFinite(overlay.maxCandidateBenchmarkR60) && candidateBenchmarkR60 > overlay.maxCandidateBenchmarkR60) return null;
  if (!Number.isFinite(candidateRelativeR20) || candidateRelativeR20 < (overlay.minCandidateRelativeR20 ?? 0.18)) return null;
  if (
    Number.isFinite(overlay.minCandidateRelativeMomentumScore) &&
    (!Number.isFinite(candidateRelativeMomentum) || candidateRelativeMomentum < overlay.minCandidateRelativeMomentumScore)
  ) return null;

  const overlayRow = findWalkForwardOverlayRow(trainingRows, decision.selected.name, overlay.overlayPatterns || []);
  if (!overlayRow) return null;
  const overlayResult = periodResultsByParam.get(overlayRow.name)?.[index];
  const highConvictionBenchmarkOverlayWeight = Number(overlayResult?.benchmarkOverlayWeight);
  if (
    !Number.isFinite(highConvictionBenchmarkOverlayWeight) ||
    highConvictionBenchmarkOverlayWeight < (overlay.minHighConvictionBenchmarkOverlayWeight ?? 0.68)
  ) return null;
  if (highConvictionBenchmarkOverlayWeight - baseBenchmarkOverlayWeight < (overlay.minOverlayWeightAdvantage ?? 0.14)) return null;

  return {
    mode: gate.mode,
    passed: true,
    reason: "beta_recovery_high_conviction_overlay_applied",
    overlayRow,
    benchmarkOverlayWeight: highConvictionBenchmarkOverlayWeight,
    baseBenchmarkOverlayWeight,
    candidateBenchmarkR20,
    candidateBenchmarkR60,
    candidateRelativeR20,
    candidateRelativeMomentum,
  };
}

function applyWalkForwardBetaRecoveryHighConvictionOverlay(decision, periodResultsByParam, index, options = {}, trainingRows = []) {
  const highConvictionResult = evaluateWalkForwardBetaRecoveryHighConvictionOverlay(decision, periodResultsByParam, index, options, trainingRows);
  if (!highConvictionResult) return null;
  return {
    decision: {
      ...decision,
      selected: highConvictionResult.overlayRow,
      selectionReason: "switched_current_beta_recovery_high_conviction_overlay",
    },
    gateResult: highConvictionResult,
  };
}

function evaluateWalkForwardDirectFreshLotteryGuardOverlay(decision, periodResultsByParam, index, options = {}, trainingRows = []) {
  const gate = normalizeWalkForwardCurrentBasketGate(options.currentBasketGate);
  const overlay = gate?.directFreshLotteryGuardOverlay;
  if (!overlay?.enabled || !decision?.selected) return null;
  if (!walkForwardPatternMatches(decision.selected.name, overlay.basePatterns || [])) return null;

  const overlayRow = findWalkForwardOverlayRow(trainingRows, decision.selected.name, overlay.overlayPatterns || []);
  if (!overlayRow) return null;

  const selectedResult = periodResultsByParam.get(decision.selected.name)?.[index];
  const candidateResult = periodResultsByParam.get(overlayRow.name)?.[index];
  const metrics = walkForwardCurrentBasketMetrics(candidateResult, selectedResult);
  const candidateScoredCount = Number(candidateResult?.scoredCount);
  const candidateFreshTrend = metrics.candidateFreshTrend;
  const candidateR20 = metrics.candidateR20;
  const candidateLotterySpike = basketMetricAverage(candidateResult, "lotterySpikeScore");
  const selectedLotterySpike = basketMetricAverage(selectedResult, "lotterySpikeScore");
  const candidateMaxDailyReturn20 = basketMetricAverage(candidateResult, "maxDailyReturn20");
  const selectedMaxDailyReturn20 = basketMetricAverage(selectedResult, "maxDailyReturn20");
  const lotteryGuardScoreAdvantage = Number.isFinite(candidateLotterySpike) && Number.isFinite(selectedLotterySpike)
    ? candidateLotterySpike - selectedLotterySpike
    : null;
  const maxDailyReturnReduction20 = Number.isFinite(candidateMaxDailyReturn20) && Number.isFinite(selectedMaxDailyReturn20)
    ? selectedMaxDailyReturn20 - candidateMaxDailyReturn20
    : null;

  if (!Number.isFinite(candidateScoredCount) || candidateScoredCount < (overlay.minCandidateScoredCount ?? 1400)) return null;
  if (!Number.isFinite(candidateFreshTrend) || candidateFreshTrend < (overlay.minCandidateFreshTrend ?? 55)) return null;
  if (Number.isFinite(overlay.maxCandidateFreshTrend) && candidateFreshTrend > overlay.maxCandidateFreshTrend) return null;
  if (!Number.isFinite(candidateLotterySpike) || candidateLotterySpike < (overlay.minCandidateLotterySpikeScore ?? 96.5)) return null;
  if (!Number.isFinite(lotteryGuardScoreAdvantage) || lotteryGuardScoreAdvantage < (overlay.minLotteryGuardScoreAdvantage ?? 4)) return null;
  if (!Number.isFinite(candidateMaxDailyReturn20) || candidateMaxDailyReturn20 > (overlay.maxCandidateMaxDailyReturn20 ?? 0.08)) return null;
  if (!Number.isFinite(maxDailyReturnReduction20) || maxDailyReturnReduction20 < (overlay.minMaxDailyReturnReduction20 ?? 0.02)) return null;
  if (Number.isFinite(overlay.maxCandidateR20) && (!Number.isFinite(candidateR20) || candidateR20 > overlay.maxCandidateR20)) return null;

  return {
    mode: gate.mode,
    passed: true,
    reason: "direct_fresh_lottery_guard_overlay_applied",
    overlayRow,
    candidateScoredCount,
    lotteryGuardScore: candidateLotterySpike,
    lotteryGuardFreshTrend: candidateFreshTrend,
    lotteryGuardScoreAdvantage,
    maxDailyReturnReduction20,
    candidateMaxDailyReturn20,
    selectedMaxDailyReturn20,
    ...metrics,
  };
}

function applyWalkForwardDirectFreshLotteryGuardOverlay(decision, periodResultsByParam, index, options = {}, trainingRows = []) {
  const directLotteryGuardResult = evaluateWalkForwardDirectFreshLotteryGuardOverlay(decision, periodResultsByParam, index, options, trainingRows);
  if (!directLotteryGuardResult) return null;
  return {
    decision: {
      ...decision,
      selected: directLotteryGuardResult.overlayRow,
      selectionReason: "switched_current_direct_fresh_lottery_guard_overlay",
    },
    gateResult: directLotteryGuardResult,
  };
}

function evaluateWalkForwardFreshReversalStabilityOverlay(decision, periodResultsByParam, index, options = {}, trainingRows = []) {
  const gate = normalizeWalkForwardCurrentBasketGate(options.currentBasketGate);
  const overlay = gate?.freshReversalStabilityOverlay;
  if (!overlay?.enabled || !decision?.selected) return null;
  if (!walkForwardPatternMatches(decision.selected.name, overlay.basePatterns || [])) return null;

  const overlayRow = findWalkForwardOverlayRow(trainingRows, decision.selected.name, overlay.overlayPatterns || []);
  if (!overlayRow) return null;

  const selectedResult = periodResultsByParam.get(decision.selected.name)?.[index];
  const candidateResult = periodResultsByParam.get(overlayRow.name)?.[index];
  const metrics = walkForwardCurrentBasketMetrics(candidateResult, selectedResult);
  const selectedFreshTrend = metrics.incumbentFreshTrend;
  const selectedIndustryResidualRank = metrics.incumbentIndustryResidualRank;
  const candidateFreshTrend = metrics.candidateFreshTrend;
  const candidateRelativeMomentum = metrics.candidateRelativeMomentum;
  const candidateShortTermReversal = basketMetricAverage(candidateResult, "shortTermReversalScore");
  const candidateTurnoverStability = basketMetricAverage(candidateResult, "turnoverStabilityScore");
  const candidateLotterySpike = basketMetricAverage(candidateResult, "lotterySpikeScore");
  const candidateMaxDailyReturn20 = basketMetricAverage(candidateResult, "maxDailyReturn20");
  const candidateVol20 = basketMetricAverage(candidateResult, "vol20");

  if (!Number.isFinite(selectedFreshTrend) || selectedFreshTrend < (overlay.minSelectedFreshTrend ?? 80)) return null;
  if (
    Number.isFinite(overlay.maxSelectedIndustryResidualRankScore) &&
    (!Number.isFinite(selectedIndustryResidualRank) || selectedIndustryResidualRank > overlay.maxSelectedIndustryResidualRankScore)
  ) return null;
  if (!Number.isFinite(candidateFreshTrend) || candidateFreshTrend < (overlay.minCandidateFreshTrend ?? 50)) return null;
  if (Number.isFinite(overlay.maxCandidateFreshTrend) && candidateFreshTrend > overlay.maxCandidateFreshTrend) return null;
  if (
    Number.isFinite(overlay.minCandidateRelativeMomentumScore) &&
    (!Number.isFinite(candidateRelativeMomentum) || candidateRelativeMomentum < overlay.minCandidateRelativeMomentumScore)
  ) return null;
  if (
    Number.isFinite(overlay.minCandidateShortTermReversalScore) &&
    (!Number.isFinite(candidateShortTermReversal) || candidateShortTermReversal < overlay.minCandidateShortTermReversalScore)
  ) return null;
  if (
    Number.isFinite(overlay.minCandidateTurnoverStabilityScore) &&
    (!Number.isFinite(candidateTurnoverStability) || candidateTurnoverStability < overlay.minCandidateTurnoverStabilityScore)
  ) return null;
  if (
    Number.isFinite(overlay.minCandidateLotterySpikeScore) &&
    (!Number.isFinite(candidateLotterySpike) || candidateLotterySpike < overlay.minCandidateLotterySpikeScore)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateMaxDailyReturn20) &&
    (!Number.isFinite(candidateMaxDailyReturn20) || candidateMaxDailyReturn20 > overlay.maxCandidateMaxDailyReturn20)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateVol20) &&
    (!Number.isFinite(candidateVol20) || candidateVol20 > overlay.maxCandidateVol20)
  ) return null;

  return {
    mode: gate.mode,
    passed: true,
    reason: "fresh_reversal_stability_overlay_applied",
    overlayRow,
    freshTrend: candidateFreshTrend,
    shortTermReversalScore: candidateShortTermReversal,
    turnoverStabilityScore: candidateTurnoverStability,
    lotteryGuardScore: candidateLotterySpike,
    candidateMaxDailyReturn20,
    candidateVol20,
    selectedFreshTrend,
    selectedIndustryResidualRankScore: selectedIndustryResidualRank,
    ...metrics,
  };
}

function applyWalkForwardFreshReversalStabilityOverlay(decision, periodResultsByParam, index, options = {}, trainingRows = []) {
  const reversalStabilityResult = evaluateWalkForwardFreshReversalStabilityOverlay(decision, periodResultsByParam, index, options, trainingRows);
  if (!reversalStabilityResult) return null;
  return {
    decision: {
      ...decision,
      selected: reversalStabilityResult.overlayRow,
      selectionReason: "switched_current_fresh_reversal_stability_overlay",
    },
    gateResult: reversalStabilityResult,
  };
}

function evaluateWalkForwardFreshVolumeMomentumOverlay(decision, periodResultsByParam, index, options = {}, trainingRows = []) {
  const gate = normalizeWalkForwardCurrentBasketGate(options.currentBasketGate);
  const overlay = gate?.freshVolumeMomentumOverlay;
  if (!overlay?.enabled || !decision?.selected) return null;
  if (!walkForwardPatternMatches(decision.selected.name, overlay.basePatterns || [])) return null;
  if (
    Array.isArray(overlay.requiredSelectionReasons) &&
    overlay.requiredSelectionReasons.length &&
    !overlay.requiredSelectionReasons.includes(decision.selectionReason)
  ) return null;

  const overlayRow = findWalkForwardOverlayRow(trainingRows, decision.selected.name, overlay.overlayPatterns || []);
  if (!overlayRow) return null;

  const selectedResult = periodResultsByParam.get(decision.selected.name)?.[index];
  const candidateResult = periodResultsByParam.get(overlayRow.name)?.[index];
  const metrics = walkForwardCurrentBasketMetrics(candidateResult, selectedResult);
  const selectedFreshTrend = metrics.incumbentFreshTrend;
  const selectedVolumeMomentum = basketMetricAverage(selectedResult, "volumeMomentumScore");
  const selectedRelativeMomentum = metrics.incumbentRelativeMomentum;
  const selectedR20 = metrics.incumbentR20;
  const candidateFreshTrend = metrics.candidateFreshTrend;
  const candidateR20 = metrics.candidateR20;
  const candidateRelativeR20 = basketMetricAverage(candidateResult, "relativeR20");
  const candidateRelativeMomentum = metrics.candidateRelativeMomentum;
  const candidateVolumeMomentum = basketMetricAverage(candidateResult, "volumeMomentumScore");
  const candidateVolumeTurnoverRatio = basketMetricAverage(candidateResult, "volumeTurnoverRatio5v20");
  const candidateLotterySpike = basketMetricAverage(candidateResult, "lotterySpikeScore");
  const candidateEntryDayReturn = basketMetricAverage(candidateResult, "entryDayReturn");

  if (
    Number.isFinite(overlay.maxSelectedFreshTrend) &&
    (!Number.isFinite(selectedFreshTrend) || selectedFreshTrend > overlay.maxSelectedFreshTrend)
  ) return null;
  if (
    Number.isFinite(overlay.maxSelectedVolumeMomentumScore) &&
    (!Number.isFinite(selectedVolumeMomentum) || selectedVolumeMomentum > overlay.maxSelectedVolumeMomentumScore)
  ) return null;
  if (
    Number.isFinite(overlay.maxSelectedR20) &&
    (!Number.isFinite(selectedR20) || selectedR20 > overlay.maxSelectedR20)
  ) return null;
  if (
    Number.isFinite(overlay.maxSelectedRelativeMomentumScore) &&
    (!Number.isFinite(selectedRelativeMomentum) || selectedRelativeMomentum > overlay.maxSelectedRelativeMomentumScore)
  ) return null;
  if (!Number.isFinite(candidateFreshTrend) || candidateFreshTrend < (overlay.minCandidateFreshTrend ?? 70)) return null;
  if (Number.isFinite(overlay.maxCandidateFreshTrend) && candidateFreshTrend > overlay.maxCandidateFreshTrend) return null;
  if (
    Number.isFinite(overlay.minCandidateVolumeMomentumScore) &&
    (!Number.isFinite(candidateVolumeMomentum) || candidateVolumeMomentum < overlay.minCandidateVolumeMomentumScore)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateVolumeMomentumScore) &&
    (!Number.isFinite(candidateVolumeMomentum) || candidateVolumeMomentum > overlay.maxCandidateVolumeMomentumScore)
  ) return null;
  if (
    Number.isFinite(overlay.minCandidateVolumeTurnoverRatio) &&
    (!Number.isFinite(candidateVolumeTurnoverRatio) || candidateVolumeTurnoverRatio < overlay.minCandidateVolumeTurnoverRatio)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateVolumeTurnoverRatio) &&
    (!Number.isFinite(candidateVolumeTurnoverRatio) || candidateVolumeTurnoverRatio > overlay.maxCandidateVolumeTurnoverRatio)
  ) return null;
  if (!Number.isFinite(candidateR20) || candidateR20 < (overlay.minCandidateR20 ?? 0.18)) return null;
  if (Number.isFinite(overlay.maxCandidateR20) && candidateR20 > overlay.maxCandidateR20) return null;
  if (!Number.isFinite(candidateRelativeR20) || candidateRelativeR20 < (overlay.minCandidateRelativeR20 ?? 0.20)) return null;
  if (
    Number.isFinite(overlay.minCandidateRelativeMomentumScore) &&
    (!Number.isFinite(candidateRelativeMomentum) || candidateRelativeMomentum < overlay.minCandidateRelativeMomentumScore)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateLotterySpikeScore) &&
    (!Number.isFinite(candidateLotterySpike) || candidateLotterySpike > overlay.maxCandidateLotterySpikeScore)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateEntryDayReturn) &&
    (!Number.isFinite(candidateEntryDayReturn) || candidateEntryDayReturn > overlay.maxCandidateEntryDayReturn)
  ) return null;

  return {
    mode: gate.mode,
    passed: true,
    reason: "fresh_volume_momentum_overlay_applied",
    overlayRow,
    freshTrend: candidateFreshTrend,
    volumeMomentumScore: candidateVolumeMomentum,
    volumeTurnoverRatio: candidateVolumeTurnoverRatio,
    lotteryGuardScore: candidateLotterySpike,
    candidateR20,
    candidateRelativeR20,
    candidateRelativeMomentum,
    candidateEntryDayReturn,
    selectedFreshTrend,
    selectedVolumeMomentumScore: selectedVolumeMomentum,
    selectedR20,
    selectedRelativeMomentum,
    ...metrics,
  };
}

function applyWalkForwardFreshVolumeMomentumOverlay(decision, periodResultsByParam, index, options = {}, trainingRows = []) {
  const volumeMomentumResult = evaluateWalkForwardFreshVolumeMomentumOverlay(decision, periodResultsByParam, index, options, trainingRows);
  if (!volumeMomentumResult) return null;
  return {
    decision: {
      ...decision,
      selected: volumeMomentumResult.overlayRow,
      selectionReason: "switched_current_fresh_volume_momentum_overlay",
    },
    gateResult: volumeMomentumResult,
  };
}

function evaluateWalkForwardIncumbentReversalStabilityOverlay(
  decision,
  periodResultsByParam,
  index,
  options = {},
  trainingRows = [],
  overlayKey = "incumbentReversalStabilityOverlay",
  reason = "incumbent_reversal_stability_overlay_applied"
) {
  const gate = normalizeWalkForwardCurrentBasketGate(options.currentBasketGate);
  const overlay = gate?.[overlayKey];
  if (!overlay?.enabled || !decision?.selected) return null;
  if (!walkForwardPatternMatches(decision.selected.name, overlay.incumbentPatterns || [])) return null;
  if (
    Array.isArray(overlay.requiredSelectionReasons) &&
    overlay.requiredSelectionReasons.length &&
    !overlay.requiredSelectionReasons.includes(decision.selectionReason)
  ) return null;

  const overlayRow = findWalkForwardOverlayRow(trainingRows, decision.selected.name, overlay.overlayPatterns || []);
  if (!overlayRow) return null;

  const selectedResult = periodResultsByParam.get(decision.selected.name)?.[index];
  const candidateResult = periodResultsByParam.get(overlayRow.name)?.[index];
  const metrics = walkForwardCurrentBasketMetrics(candidateResult, selectedResult);
  const candidateScoredCount = Number(candidateResult?.scoredCount);
  const candidateBenchmarkR20 = basketMetricAverage(candidateResult, "benchmarkR20");
  const candidateBenchmarkR60 = basketMetricAverage(candidateResult, "benchmarkR60");
  const candidateFreshTrend = metrics.candidateFreshTrend;
  const candidateR20 = metrics.candidateR20;
  const candidateRelativeR20 = basketMetricAverage(candidateResult, "relativeR20");
  const candidateRelativeMomentum = metrics.candidateRelativeMomentum;
  const candidateIndustryResidualRank = metrics.candidateIndustryResidualRank;
  const candidateShortTermReversal = basketMetricAverage(candidateResult, "shortTermReversalScore");
  const candidateTurnoverStability = basketMetricAverage(candidateResult, "turnoverStabilityScore");
  const candidateLotterySpike = basketMetricAverage(candidateResult, "lotterySpikeScore");
  const candidateMaxDailyReturn20 = basketMetricAverage(candidateResult, "maxDailyReturn20");
  const candidateVol20 = basketMetricAverage(candidateResult, "vol20");
  const candidateVolumeMomentum = basketMetricAverage(candidateResult, "volumeMomentumScore");
  const candidateVolumeTurnoverRatio = basketMetricAverage(candidateResult, "volumeTurnoverRatio5v20");
  const candidateEntryDayReturn = basketMetricAverage(candidateResult, "entryDayReturn");
  const candidateIndustryBreadth20 = basketMetricAverage(candidateResult, "industryBreadth20");

  if (
    Number.isFinite(overlay.minCandidateScoredCount) &&
    (!Number.isFinite(candidateScoredCount) || candidateScoredCount < overlay.minCandidateScoredCount)
  ) return null;
  if (
    Number.isFinite(overlay.minCandidateBenchmarkR20) &&
    (!Number.isFinite(candidateBenchmarkR20) || candidateBenchmarkR20 < overlay.minCandidateBenchmarkR20)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateBenchmarkR20) &&
    (!Number.isFinite(candidateBenchmarkR20) || candidateBenchmarkR20 > overlay.maxCandidateBenchmarkR20)
  ) return null;
  if (
    Number.isFinite(overlay.minCandidateBenchmarkR60) &&
    (!Number.isFinite(candidateBenchmarkR60) || candidateBenchmarkR60 < overlay.minCandidateBenchmarkR60)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateBenchmarkR60) &&
    (!Number.isFinite(candidateBenchmarkR60) || candidateBenchmarkR60 > overlay.maxCandidateBenchmarkR60)
  ) return null;
  if (!Number.isFinite(candidateFreshTrend) || candidateFreshTrend < (overlay.minCandidateFreshTrend ?? 67)) return null;
  if (Number.isFinite(overlay.maxCandidateFreshTrend) && candidateFreshTrend > overlay.maxCandidateFreshTrend) return null;
  if (
    Number.isFinite(overlay.minCandidateR20) &&
    (!Number.isFinite(candidateR20) || candidateR20 < overlay.minCandidateR20)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateR20) &&
    (!Number.isFinite(candidateR20) || candidateR20 > overlay.maxCandidateR20)
  ) return null;
  if (!Number.isFinite(candidateRelativeR20) || candidateRelativeR20 < (overlay.minCandidateRelativeR20 ?? 0.16)) return null;
  if (Number.isFinite(overlay.maxCandidateRelativeR20) && candidateRelativeR20 > overlay.maxCandidateRelativeR20) return null;
  if (
    Number.isFinite(overlay.minCandidateRelativeMomentumScore) &&
    (!Number.isFinite(candidateRelativeMomentum) || candidateRelativeMomentum < overlay.minCandidateRelativeMomentumScore)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateRelativeMomentumScore) &&
    (!Number.isFinite(candidateRelativeMomentum) || candidateRelativeMomentum > overlay.maxCandidateRelativeMomentumScore)
  ) return null;
  if (
    Number.isFinite(overlay.minCandidateIndustryResidualRankScore) &&
    (!Number.isFinite(candidateIndustryResidualRank) || candidateIndustryResidualRank < overlay.minCandidateIndustryResidualRankScore)
  ) return null;
  if (
    Number.isFinite(overlay.minCandidateShortTermReversalScore) &&
    (!Number.isFinite(candidateShortTermReversal) || candidateShortTermReversal < overlay.minCandidateShortTermReversalScore)
  ) return null;
  if (
    Number.isFinite(overlay.minCandidateTurnoverStabilityScore) &&
    (!Number.isFinite(candidateTurnoverStability) || candidateTurnoverStability < overlay.minCandidateTurnoverStabilityScore)
  ) return null;
  if (
    Number.isFinite(overlay.minCandidateLotterySpikeScore) &&
    (!Number.isFinite(candidateLotterySpike) || candidateLotterySpike < overlay.minCandidateLotterySpikeScore)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateLotterySpikeScore) &&
    (!Number.isFinite(candidateLotterySpike) || candidateLotterySpike > overlay.maxCandidateLotterySpikeScore)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateMaxDailyReturn20) &&
    (!Number.isFinite(candidateMaxDailyReturn20) || candidateMaxDailyReturn20 > overlay.maxCandidateMaxDailyReturn20)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateVol20) &&
    (!Number.isFinite(candidateVol20) || candidateVol20 > overlay.maxCandidateVol20)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateEntryDayReturn) &&
    (!Number.isFinite(candidateEntryDayReturn) || candidateEntryDayReturn > overlay.maxCandidateEntryDayReturn)
  ) return null;
  if (
    Number.isFinite(overlay.minCandidateIndustryBreadth20) &&
    (!Number.isFinite(candidateIndustryBreadth20) || candidateIndustryBreadth20 < overlay.minCandidateIndustryBreadth20)
  ) return null;

  return {
    mode: gate.mode,
    passed: true,
    reason,
    overlayRow,
    candidateBenchmarkR20,
    candidateBenchmarkR60,
    freshTrend: candidateFreshTrend,
    shortTermReversalScore: candidateShortTermReversal,
    turnoverStabilityScore: candidateTurnoverStability,
    lotteryGuardScore: candidateLotterySpike,
    volumeMomentumScore: candidateVolumeMomentum,
    volumeTurnoverRatio: candidateVolumeTurnoverRatio,
    candidateR20,
    candidateRelativeR20,
    candidateRelativeMomentum,
    candidateIndustryResidualRankScore: candidateIndustryResidualRank,
    candidateEntryDayReturn,
    candidateMaxDailyReturn20,
    candidateVol20,
    candidateIndustryBreadth20,
    ...metrics,
  };
}

function applyWalkForwardIncumbentReversalStabilityOverlay(decision, periodResultsByParam, index, options = {}, trainingRows = []) {
  const incumbentReversalResult = evaluateWalkForwardIncumbentReversalStabilityOverlay(decision, periodResultsByParam, index, options, trainingRows);
  if (!incumbentReversalResult) return null;
  return {
    decision: {
      ...decision,
      selected: incumbentReversalResult.overlayRow,
      selectionReason: "switched_current_incumbent_reversal_stability_overlay",
    },
    gateResult: incumbentReversalResult,
  };
}

function applyWalkForwardBroadPoolReversalStabilityOverlay(decision, periodResultsByParam, index, options = {}, trainingRows = []) {
  const broadReversalResult = evaluateWalkForwardIncumbentReversalStabilityOverlay(
    decision,
    periodResultsByParam,
    index,
    options,
    trainingRows,
    "broadPoolReversalStabilityOverlay",
    "broad_pool_reversal_stability_overlay_applied"
  );
  if (!broadReversalResult) return null;
  return {
    decision: {
      ...decision,
      selected: broadReversalResult.overlayRow,
      selectionReason: "switched_current_broad_pool_reversal_stability_overlay",
    },
    gateResult: broadReversalResult,
  };
}

function applyWalkForwardBenchmarkPullbackReversalStabilityOverlay(decision, periodResultsByParam, index, options = {}, trainingRows = []) {
  const pullbackReversalResult = evaluateWalkForwardIncumbentReversalStabilityOverlay(
    decision,
    periodResultsByParam,
    index,
    options,
    trainingRows,
    "benchmarkPullbackReversalStabilityOverlay",
    "benchmark_pullback_reversal_stability_overlay_applied"
  );
  if (!pullbackReversalResult) return null;
  return {
    decision: {
      ...decision,
      selected: pullbackReversalResult.overlayRow,
      selectionReason: "switched_current_benchmark_pullback_reversal_stability_overlay",
    },
    gateResult: pullbackReversalResult,
  };
}

function evaluateWalkForwardBenchmarkPullbackVolumeMomentumOverlay(
  decision,
  periodResultsByParam,
  index,
  options = {},
  trainingRows = [],
  overlayKey = "benchmarkPullbackVolumeMomentumOverlay",
  reason = "benchmark_pullback_volume_momentum_overlay_applied"
) {
  const gate = normalizeWalkForwardCurrentBasketGate(options.currentBasketGate);
  const overlay = gate?.[overlayKey];
  if (!overlay?.enabled || !decision?.selected) return null;
  if (!walkForwardPatternMatches(decision.selected.name, overlay.basePatterns || [])) return null;
  if (
    Array.isArray(overlay.requiredSelectionReasons) &&
    overlay.requiredSelectionReasons.length &&
    !overlay.requiredSelectionReasons.includes(decision.selectionReason)
  ) return null;

  const overlayRow = findWalkForwardOverlayRow(trainingRows, decision.selected.name, overlay.overlayPatterns || []);
  if (!overlayRow) return null;

  const selectedResult = periodResultsByParam.get(decision.selected.name)?.[index];
  const candidateResult = periodResultsByParam.get(overlayRow.name)?.[index];
  const metrics = walkForwardCurrentBasketMetrics(candidateResult, selectedResult);
  const candidateScoredCount = Number(candidateResult?.scoredCount);
  const candidateBenchmarkR20 = basketMetricAverage(candidateResult, "benchmarkR20");
  const candidateBenchmarkR60 = basketMetricAverage(candidateResult, "benchmarkR60");
  const candidateFreshTrend = metrics.candidateFreshTrend;
  const candidateR20 = metrics.candidateR20;
  const candidateRelativeR20 = basketMetricAverage(candidateResult, "relativeR20");
  const candidateRelativeMomentum = metrics.candidateRelativeMomentum;
  const candidateIndustryResidualRank = metrics.candidateIndustryResidualRank;
  const candidateVolumeMomentum = basketMetricAverage(candidateResult, "volumeMomentumScore");
  const candidateVolumeTurnoverRatio = basketMetricAverage(candidateResult, "volumeTurnoverRatio5v20");
  const candidateLotterySpike = basketMetricAverage(candidateResult, "lotterySpikeScore");
  const candidateEntryDayReturn = basketMetricAverage(candidateResult, "entryDayReturn");
  const candidateMaxDailyReturn20 = basketMetricAverage(candidateResult, "maxDailyReturn20");
  const candidateVol20 = basketMetricAverage(candidateResult, "vol20");
  const candidateIndustryBreadth20 = basketMetricAverage(candidateResult, "industryBreadth20");

  if (
    Number.isFinite(overlay.minCandidateScoredCount) &&
    (!Number.isFinite(candidateScoredCount) || candidateScoredCount < overlay.minCandidateScoredCount)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateScoredCount) &&
    (!Number.isFinite(candidateScoredCount) || candidateScoredCount > overlay.maxCandidateScoredCount)
  ) return null;
  if (!Number.isFinite(candidateBenchmarkR20) || candidateBenchmarkR20 < (overlay.minCandidateBenchmarkR20 ?? -0.035)) return null;
  if (Number.isFinite(overlay.maxCandidateBenchmarkR20) && candidateBenchmarkR20 > overlay.maxCandidateBenchmarkR20) return null;
  if (!Number.isFinite(candidateBenchmarkR60) || candidateBenchmarkR60 < (overlay.minCandidateBenchmarkR60 ?? 0.05)) return null;
  if (Number.isFinite(overlay.maxCandidateBenchmarkR60) && candidateBenchmarkR60 > overlay.maxCandidateBenchmarkR60) return null;
  if (!Number.isFinite(candidateFreshTrend) || candidateFreshTrend < (overlay.minCandidateFreshTrend ?? 64)) return null;
  if (Number.isFinite(overlay.maxCandidateFreshTrend) && candidateFreshTrend > overlay.maxCandidateFreshTrend) return null;
  if (!Number.isFinite(candidateR20) || candidateR20 < (overlay.minCandidateR20 ?? 0.22)) return null;
  if (Number.isFinite(overlay.maxCandidateR20) && candidateR20 > overlay.maxCandidateR20) return null;
  if (!Number.isFinite(candidateRelativeR20) || candidateRelativeR20 < (overlay.minCandidateRelativeR20 ?? 0.24)) return null;
  if (Number.isFinite(overlay.maxCandidateRelativeR20) && candidateRelativeR20 > overlay.maxCandidateRelativeR20) return null;
  if (
    Number.isFinite(overlay.minCandidateRelativeMomentumScore) &&
    (!Number.isFinite(candidateRelativeMomentum) || candidateRelativeMomentum < overlay.minCandidateRelativeMomentumScore)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateRelativeMomentumScore) &&
    (!Number.isFinite(candidateRelativeMomentum) || candidateRelativeMomentum > overlay.maxCandidateRelativeMomentumScore)
  ) return null;
  if (
    Number.isFinite(overlay.minCandidateIndustryResidualRankScore) &&
    (!Number.isFinite(candidateIndustryResidualRank) || candidateIndustryResidualRank < overlay.minCandidateIndustryResidualRankScore)
  ) return null;
  if (
    Number.isFinite(overlay.minCandidateVolumeMomentumScore) &&
    (!Number.isFinite(candidateVolumeMomentum) || candidateVolumeMomentum < overlay.minCandidateVolumeMomentumScore)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateVolumeMomentumScore) &&
    (!Number.isFinite(candidateVolumeMomentum) || candidateVolumeMomentum > overlay.maxCandidateVolumeMomentumScore)
  ) return null;
  if (
    Number.isFinite(overlay.minCandidateVolumeTurnoverRatio) &&
    (!Number.isFinite(candidateVolumeTurnoverRatio) || candidateVolumeTurnoverRatio < overlay.minCandidateVolumeTurnoverRatio)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateVolumeTurnoverRatio) &&
    (!Number.isFinite(candidateVolumeTurnoverRatio) || candidateVolumeTurnoverRatio > overlay.maxCandidateVolumeTurnoverRatio)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateLotterySpikeScore) &&
    (!Number.isFinite(candidateLotterySpike) || candidateLotterySpike > overlay.maxCandidateLotterySpikeScore)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateEntryDayReturn) &&
    (!Number.isFinite(candidateEntryDayReturn) || candidateEntryDayReturn > overlay.maxCandidateEntryDayReturn)
  ) return null;
  if (
    Number.isFinite(overlay.minCandidateEntryDayReturn) &&
    (!Number.isFinite(candidateEntryDayReturn) || candidateEntryDayReturn < overlay.minCandidateEntryDayReturn)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateMaxDailyReturn20) &&
    (!Number.isFinite(candidateMaxDailyReturn20) || candidateMaxDailyReturn20 > overlay.maxCandidateMaxDailyReturn20)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateVol20) &&
    (!Number.isFinite(candidateVol20) || candidateVol20 > overlay.maxCandidateVol20)
  ) return null;
  if (
    Number.isFinite(overlay.minCandidateIndustryBreadth20) &&
    (!Number.isFinite(candidateIndustryBreadth20) || candidateIndustryBreadth20 < overlay.minCandidateIndustryBreadth20)
  ) return null;

  return {
    mode: gate.mode,
    passed: true,
    reason,
    overlayRow,
    candidateScoredCount,
    freshTrend: candidateFreshTrend,
    volumeMomentumScore: candidateVolumeMomentum,
    volumeTurnoverRatio: candidateVolumeTurnoverRatio,
    lotteryGuardScore: candidateLotterySpike,
    candidateBenchmarkR20,
    candidateBenchmarkR60,
    candidateR20,
    candidateRelativeR20,
    candidateRelativeMomentum,
    candidateIndustryResidualRankScore: candidateIndustryResidualRank,
    candidateEntryDayReturn,
    candidateMaxDailyReturn20,
    candidateVol20,
    candidateIndustryBreadth20,
    ...metrics,
  };
}

function applyWalkForwardBenchmarkPullbackVolumeMomentumOverlay(decision, periodResultsByParam, index, options = {}, trainingRows = []) {
  const volumeMomentumResult = evaluateWalkForwardBenchmarkPullbackVolumeMomentumOverlay(decision, periodResultsByParam, index, options, trainingRows);
  if (!volumeMomentumResult) return null;
  return {
    decision: {
      ...decision,
      selected: volumeMomentumResult.overlayRow,
      selectionReason: "switched_current_benchmark_pullback_volume_momentum_overlay",
    },
    gateResult: volumeMomentumResult,
  };
}

function applyWalkForwardBenchmarkPullbackResidualVolumeMomentumOverlay(decision, periodResultsByParam, index, options = {}, trainingRows = []) {
  const volumeMomentumResult = evaluateWalkForwardBenchmarkPullbackVolumeMomentumOverlay(
    decision,
    periodResultsByParam,
    index,
    options,
    trainingRows,
    "benchmarkPullbackResidualVolumeMomentumOverlay",
    "benchmark_pullback_residual_volume_momentum_overlay_applied"
  );
  if (!volumeMomentumResult) return null;
  return {
    decision: {
      ...decision,
      selected: volumeMomentumResult.overlayRow,
      selectionReason: "switched_current_benchmark_pullback_residual_volume_momentum_overlay",
    },
    gateResult: volumeMomentumResult,
  };
}

function applyWalkForwardBroadPoolVolumeMomentumOverlay(decision, periodResultsByParam, index, options = {}, trainingRows = []) {
  const volumeMomentumResult = evaluateWalkForwardBenchmarkPullbackVolumeMomentumOverlay(
    decision,
    periodResultsByParam,
    index,
    options,
    trainingRows,
    "broadPoolVolumeMomentumOverlay",
    "broad_pool_volume_momentum_overlay_applied"
  );
  if (!volumeMomentumResult) return null;
  return {
    decision: {
      ...decision,
      selected: volumeMomentumResult.overlayRow,
      selectionReason: "switched_current_broad_pool_volume_momentum_overlay",
    },
    gateResult: volumeMomentumResult,
  };
}

function applyWalkForwardNarrowNoStaticMeltupOverlay(decision, periodResultsByParam, index, options = {}, trainingRows = []) {
  const noStaticMeltupResult = evaluateWalkForwardBenchmarkPullbackVolumeMomentumOverlay(
    decision,
    periodResultsByParam,
    index,
    options,
    trainingRows,
    "narrowNoStaticMeltupOverlay",
    "narrow_no_static_meltup_overlay_applied"
  );
  if (!noStaticMeltupResult) return null;
  return {
    decision: {
      ...decision,
      selected: noStaticMeltupResult.overlayRow,
      selectionReason: "switched_current_narrow_no_static_meltup_overlay",
    },
    gateResult: noStaticMeltupResult,
  };
}

function evaluateWalkForwardFreshRotationReversalStabilityOverlay(decision, periodResultsByParam, index, options = {}, trainingRows = []) {
  const gate = normalizeWalkForwardCurrentBasketGate(options.currentBasketGate);
  const overlay = gate?.freshRotationReversalStabilityOverlay;
  if (!overlay?.enabled || !decision?.selected) return null;
  if (!walkForwardPatternMatches(decision.selected.name, overlay.basePatterns || [])) return null;
  if (
    Array.isArray(overlay.requiredSelectionReasons) &&
    overlay.requiredSelectionReasons.length &&
    !overlay.requiredSelectionReasons.includes(decision.selectionReason)
  ) return null;

  const overlayRow = findWalkForwardOverlayRow(trainingRows, decision.selected.name, overlay.overlayPatterns || []);
  if (!overlayRow) return null;

  const selectedResult = periodResultsByParam.get(decision.selected.name)?.[index];
  const candidateResult = periodResultsByParam.get(overlayRow.name)?.[index];
  const metrics = walkForwardCurrentBasketMetrics(candidateResult, selectedResult);
  const selectedFreshTrend = metrics.incumbentFreshTrend;
  const selectedR20 = metrics.incumbentR20;
  const selectedRelativeMomentum = metrics.incumbentRelativeMomentum;
  const selectedTurnoverStability = basketMetricAverage(selectedResult, "turnoverStabilityScore");
  const selectedLotterySpike = basketMetricAverage(selectedResult, "lotterySpikeScore");
  const candidateFreshTrend = metrics.candidateFreshTrend;
  const candidateRelativeR20 = basketMetricAverage(candidateResult, "relativeR20");
  const candidateRelativeMomentum = metrics.candidateRelativeMomentum;
  const candidateIndustryResidualRank = metrics.candidateIndustryResidualRank;
  const candidateShortTermReversal = basketMetricAverage(candidateResult, "shortTermReversalScore");
  const candidateTurnoverStability = basketMetricAverage(candidateResult, "turnoverStabilityScore");
  const candidateLotterySpike = basketMetricAverage(candidateResult, "lotterySpikeScore");
  const candidateEntryDayReturn = basketMetricAverage(candidateResult, "entryDayReturn");
  const candidateMaxDailyReturn20 = basketMetricAverage(candidateResult, "maxDailyReturn20");
  const candidateVol20 = basketMetricAverage(candidateResult, "vol20");

  if (!Number.isFinite(selectedFreshTrend) || selectedFreshTrend < (overlay.minSelectedFreshTrend ?? 72)) return null;
  if (!Number.isFinite(selectedR20) || selectedR20 < (overlay.minSelectedR20 ?? 0.25)) return null;
  if (
    Number.isFinite(overlay.maxSelectedRelativeMomentumScore) &&
    (!Number.isFinite(selectedRelativeMomentum) || selectedRelativeMomentum > overlay.maxSelectedRelativeMomentumScore)
  ) return null;
  if (
    Number.isFinite(overlay.maxSelectedTurnoverStabilityScore) &&
    (!Number.isFinite(selectedTurnoverStability) || selectedTurnoverStability > overlay.maxSelectedTurnoverStabilityScore)
  ) return null;
  if (
    Number.isFinite(overlay.minSelectedLotterySpikeScore) &&
    (!Number.isFinite(selectedLotterySpike) || selectedLotterySpike < overlay.minSelectedLotterySpikeScore)
  ) return null;
  if (!Number.isFinite(candidateFreshTrend) || candidateFreshTrend < (overlay.minCandidateFreshTrend ?? 55)) return null;
  if (Number.isFinite(overlay.maxCandidateFreshTrend) && candidateFreshTrend > overlay.maxCandidateFreshTrend) return null;
  if (!Number.isFinite(candidateRelativeR20) || candidateRelativeR20 < (overlay.minCandidateRelativeR20 ?? 0.15)) return null;
  if (
    Number.isFinite(overlay.minCandidateRelativeMomentumScore) &&
    (!Number.isFinite(candidateRelativeMomentum) || candidateRelativeMomentum < overlay.minCandidateRelativeMomentumScore)
  ) return null;
  if (
    Number.isFinite(overlay.minCandidateIndustryResidualRankScore) &&
    (!Number.isFinite(candidateIndustryResidualRank) || candidateIndustryResidualRank < overlay.minCandidateIndustryResidualRankScore)
  ) return null;
  if (
    Number.isFinite(overlay.minCandidateShortTermReversalScore) &&
    (!Number.isFinite(candidateShortTermReversal) || candidateShortTermReversal < overlay.minCandidateShortTermReversalScore)
  ) return null;
  if (
    Number.isFinite(overlay.minCandidateTurnoverStabilityScore) &&
    (!Number.isFinite(candidateTurnoverStability) || candidateTurnoverStability < overlay.minCandidateTurnoverStabilityScore)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateLotterySpikeScore) &&
    (!Number.isFinite(candidateLotterySpike) || candidateLotterySpike > overlay.maxCandidateLotterySpikeScore)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateEntryDayReturn) &&
    (!Number.isFinite(candidateEntryDayReturn) || candidateEntryDayReturn > overlay.maxCandidateEntryDayReturn)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateMaxDailyReturn20) &&
    (!Number.isFinite(candidateMaxDailyReturn20) || candidateMaxDailyReturn20 > overlay.maxCandidateMaxDailyReturn20)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateVol20) &&
    (!Number.isFinite(candidateVol20) || candidateVol20 > overlay.maxCandidateVol20)
  ) return null;

  return {
    mode: gate.mode,
    passed: true,
    reason: "fresh_rotation_reversal_stability_overlay_applied",
    overlayRow,
    freshTrend: candidateFreshTrend,
    shortTermReversalScore: candidateShortTermReversal,
    turnoverStabilityScore: candidateTurnoverStability,
    lotteryGuardScore: candidateLotterySpike,
    candidateRelativeR20,
    candidateRelativeMomentum,
    candidateIndustryResidualRankScore: candidateIndustryResidualRank,
    candidateEntryDayReturn,
    candidateMaxDailyReturn20,
    candidateVol20,
    selectedFreshTrend,
    selectedR20,
    selectedRelativeMomentum,
    selectedTurnoverStabilityScore: selectedTurnoverStability,
    selectedLotterySpikeScore: selectedLotterySpike,
    ...metrics,
  };
}

function applyWalkForwardFreshRotationReversalStabilityOverlay(decision, periodResultsByParam, index, options = {}, trainingRows = []) {
  const reversalResult = evaluateWalkForwardFreshRotationReversalStabilityOverlay(decision, periodResultsByParam, index, options, trainingRows);
  if (!reversalResult) return null;
  return {
    decision: {
      ...decision,
      selected: reversalResult.overlayRow,
      selectionReason: "switched_current_fresh_rotation_reversal_stability_overlay",
    },
    gateResult: reversalResult,
  };
}

function evaluateWalkForwardFreshOverextensionReversalStabilityOverlay(decision, periodResultsByParam, index, options = {}, trainingRows = []) {
  const gate = normalizeWalkForwardCurrentBasketGate(options.currentBasketGate);
  const overlay = gate?.freshOverextensionReversalStabilityOverlay;
  if (!overlay?.enabled || !decision?.selected) return null;
  if (!walkForwardPatternMatches(decision.selected.name, overlay.basePatterns || [])) return null;
  if (
    Array.isArray(overlay.requiredSelectionReasons) &&
    overlay.requiredSelectionReasons.length &&
    !overlay.requiredSelectionReasons.includes(decision.selectionReason)
  ) return null;

  const overlayRow = findWalkForwardOverlayRow(trainingRows, decision.selected.name, overlay.overlayPatterns || []);
  if (!overlayRow) return null;

  const selectedResult = periodResultsByParam.get(decision.selected.name)?.[index];
  const candidateResult = periodResultsByParam.get(overlayRow.name)?.[index];
  const metrics = walkForwardCurrentBasketMetrics(candidateResult, selectedResult);
  const candidateBenchmarkR20 = basketMetricAverage(candidateResult, "benchmarkR20");
  const candidateBenchmarkR60 = basketMetricAverage(candidateResult, "benchmarkR60");
  const candidateFreshTrend = metrics.candidateFreshTrend;
  const candidateR20 = metrics.candidateR20;
  const candidateRelativeR20 = basketMetricAverage(candidateResult, "relativeR20");
  const candidateRelativeMomentum = metrics.candidateRelativeMomentum;
  const candidateIndustryResidualRank = metrics.candidateIndustryResidualRank;
  const candidateShortTermReversal = basketMetricAverage(candidateResult, "shortTermReversalScore");
  const candidateTurnoverStability = basketMetricAverage(candidateResult, "turnoverStabilityScore");
  const candidateLotterySpike = basketMetricAverage(candidateResult, "lotterySpikeScore");
  const candidateEntryDayReturn = basketMetricAverage(candidateResult, "entryDayReturn");
  const candidateMaxDailyReturn20 = basketMetricAverage(candidateResult, "maxDailyReturn20");
  const candidateVol20 = basketMetricAverage(candidateResult, "vol20");
  const candidateVolumeMomentum = basketMetricAverage(candidateResult, "volumeMomentumScore");

  if (!Number.isFinite(candidateBenchmarkR20) || candidateBenchmarkR20 < (overlay.minCandidateBenchmarkR20 ?? -0.005)) return null;
  if (Number.isFinite(overlay.maxCandidateBenchmarkR20) && candidateBenchmarkR20 > overlay.maxCandidateBenchmarkR20) return null;
  if (!Number.isFinite(candidateBenchmarkR60) || candidateBenchmarkR60 < (overlay.minCandidateBenchmarkR60 ?? -0.08)) return null;
  if (Number.isFinite(overlay.maxCandidateBenchmarkR60) && candidateBenchmarkR60 > overlay.maxCandidateBenchmarkR60) return null;
  if (!Number.isFinite(candidateFreshTrend) || candidateFreshTrend < (overlay.minCandidateFreshTrend ?? 52)) return null;
  if (Number.isFinite(overlay.maxCandidateFreshTrend) && candidateFreshTrend > overlay.maxCandidateFreshTrend) return null;
  if (!Number.isFinite(candidateR20) || candidateR20 < (overlay.minCandidateR20 ?? 0.12)) return null;
  if (Number.isFinite(overlay.maxCandidateR20) && candidateR20 > overlay.maxCandidateR20) return null;
  if (!Number.isFinite(candidateRelativeR20) || candidateRelativeR20 < (overlay.minCandidateRelativeR20 ?? 0.12)) return null;
  if (Number.isFinite(overlay.maxCandidateRelativeR20) && candidateRelativeR20 > overlay.maxCandidateRelativeR20) return null;
  if (
    Number.isFinite(overlay.minCandidateRelativeMomentumScore) &&
    (!Number.isFinite(candidateRelativeMomentum) || candidateRelativeMomentum < overlay.minCandidateRelativeMomentumScore)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateRelativeMomentumScore) &&
    (!Number.isFinite(candidateRelativeMomentum) || candidateRelativeMomentum > overlay.maxCandidateRelativeMomentumScore)
  ) return null;
  if (
    Number.isFinite(overlay.minCandidateIndustryResidualRankScore) &&
    (!Number.isFinite(candidateIndustryResidualRank) || candidateIndustryResidualRank < overlay.minCandidateIndustryResidualRankScore)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateIndustryResidualRankScore) &&
    (!Number.isFinite(candidateIndustryResidualRank) || candidateIndustryResidualRank > overlay.maxCandidateIndustryResidualRankScore)
  ) return null;
  if (
    Number.isFinite(overlay.minCandidateShortTermReversalScore) &&
    (!Number.isFinite(candidateShortTermReversal) || candidateShortTermReversal < overlay.minCandidateShortTermReversalScore)
  ) return null;
  if (
    Number.isFinite(overlay.minCandidateTurnoverStabilityScore) &&
    (!Number.isFinite(candidateTurnoverStability) || candidateTurnoverStability < overlay.minCandidateTurnoverStabilityScore)
  ) return null;
  if (
    Number.isFinite(overlay.minCandidateLotterySpikeScore) &&
    (!Number.isFinite(candidateLotterySpike) || candidateLotterySpike < overlay.minCandidateLotterySpikeScore)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateEntryDayReturn) &&
    (!Number.isFinite(candidateEntryDayReturn) || candidateEntryDayReturn > overlay.maxCandidateEntryDayReturn)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateMaxDailyReturn20) &&
    (!Number.isFinite(candidateMaxDailyReturn20) || candidateMaxDailyReturn20 > overlay.maxCandidateMaxDailyReturn20)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateVol20) &&
    (!Number.isFinite(candidateVol20) || candidateVol20 > overlay.maxCandidateVol20)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateVolumeMomentumScore) &&
    (!Number.isFinite(candidateVolumeMomentum) || candidateVolumeMomentum > overlay.maxCandidateVolumeMomentumScore)
  ) return null;

  return {
    mode: gate.mode,
    passed: true,
    reason: "fresh_overextension_reversal_stability_overlay_applied",
    overlayRow,
    candidateBenchmarkR20,
    candidateBenchmarkR60,
    freshTrend: candidateFreshTrend,
    shortTermReversalScore: candidateShortTermReversal,
    turnoverStabilityScore: candidateTurnoverStability,
    lotteryGuardScore: candidateLotterySpike,
    volumeMomentumScore: candidateVolumeMomentum,
    candidateRelativeR20,
    candidateRelativeMomentum,
    candidateIndustryResidualRankScore: candidateIndustryResidualRank,
    candidateEntryDayReturn,
    candidateMaxDailyReturn20,
    candidateVol20,
    ...metrics,
  };
}

function applyWalkForwardFreshOverextensionReversalStabilityOverlay(decision, periodResultsByParam, index, options = {}, trainingRows = []) {
  const reversalResult = evaluateWalkForwardFreshOverextensionReversalStabilityOverlay(decision, periodResultsByParam, index, options, trainingRows);
  if (!reversalResult) return null;
  return {
    decision: {
      ...decision,
      selected: reversalResult.overlayRow,
      selectionReason: "switched_current_fresh_overextension_reversal_stability_overlay",
    },
    gateResult: reversalResult,
  };
}

function evaluateWalkForwardBenchmarkPullbackAttackOverlay(decision, periodResultsByParam, index, options = {}, trainingRows = []) {
  const gate = normalizeWalkForwardCurrentBasketGate(options.currentBasketGate);
  const overlay = gate?.benchmarkPullbackAttackOverlay;
  if (!overlay?.enabled || !decision?.selected) return null;
  const overlayRow = findWalkForwardOverlayRow(trainingRows, decision.selected.name, overlay.overlayPatterns || []);
  if (!overlayRow) return null;
  const overlayResult = periodResultsByParam.get(overlayRow.name)?.[index];
  const candidateBenchmarkR20 = basketMetricAverage(overlayResult, "benchmarkR20");
  const candidateBenchmarkR60 = basketMetricAverage(overlayResult, "benchmarkR60");
  const candidateRelativeR20 = basketMetricAverage(overlayResult, "relativeR20");
  const candidateRelativeMomentum = basketMetricAverage(overlayResult, "relativeMomentumScore");
  if (!Number.isFinite(candidateBenchmarkR20)) return null;
  if (candidateBenchmarkR20 < (overlay.minCandidateBenchmarkR20 ?? -0.08)) return null;
  if (candidateBenchmarkR20 > (overlay.maxCandidateBenchmarkR20 ?? -0.03)) return null;
  if (!Number.isFinite(candidateBenchmarkR60) || candidateBenchmarkR60 < (overlay.minCandidateBenchmarkR60 ?? 0.05)) return null;
  if (Number.isFinite(overlay.maxCandidateBenchmarkR60) && candidateBenchmarkR60 > overlay.maxCandidateBenchmarkR60) return null;
  if (!Number.isFinite(candidateRelativeR20) || candidateRelativeR20 < (overlay.minCandidateRelativeR20 ?? 0.18)) return null;
  if (
    Number.isFinite(overlay.minCandidateRelativeMomentumScore) &&
    (!Number.isFinite(candidateRelativeMomentum) || candidateRelativeMomentum < overlay.minCandidateRelativeMomentumScore)
  ) return null;
  return {
    mode: gate.mode,
    passed: true,
    reason: "benchmark_pullback_attack_overlay_applied",
    overlayRow,
    candidateBenchmarkR20,
    candidateBenchmarkR60,
    candidateRelativeR20,
    candidateRelativeMomentum,
  };
}

function evaluateWalkForwardFreshOverextensionMatureFallbackOverlay(decision, periodResultsByParam, index, options = {}, trainingRows = []) {
  const gate = normalizeWalkForwardCurrentBasketGate(options.currentBasketGate);
  const overlay = gate?.freshOverextensionMatureFallbackOverlay;
  if (!overlay?.enabled || !decision?.selected || !decision?.incumbent) return null;
  if (!walkForwardPatternMatches(decision.selected.name, overlay.freshPatterns || [])) return null;
  const selectedResult = periodResultsByParam.get(decision.selected.name)?.[index];
  const incumbentResult = periodResultsByParam.get(decision.incumbent.name)?.[index];
  const metrics = walkForwardCurrentBasketMetrics(selectedResult, incumbentResult);
  if (!Number.isFinite(metrics.freshTrendAdvantage) || metrics.freshTrendAdvantage < (overlay.minFreshTrendAdvantage ?? 15)) return null;
  if (!Number.isFinite(metrics.r20Advantage) || metrics.r20Advantage < (overlay.minR20Advantage ?? 0.05)) return null;
  if (!Number.isFinite(metrics.relativeMomentumAdvantage) || metrics.relativeMomentumAdvantage >= (overlay.maxRelativeMomentumAdvantage ?? 8)) return null;
  if (!Number.isFinite(metrics.industryResidualAdvantage) || metrics.industryResidualAdvantage >= (overlay.maxIndustryResidualAdvantage ?? 8)) return null;
  const overlayRow = findWalkForwardOverlayRow(trainingRows, decision.selected.name, overlay.overlayPatterns || []);
  if (!overlayRow) return null;
  return {
    mode: gate.mode,
    passed: true,
    reason: "fresh_overextension_mature_fallback_overlay_applied",
    overlayRow,
    ...metrics,
  };
}

function evaluateWalkForwardFreshResidualContinuationOverlay(decision, periodResultsByParam, index, options = {}, trainingRows = []) {
  const gate = normalizeWalkForwardCurrentBasketGate(options.currentBasketGate);
  const overlay = gate?.freshResidualContinuationOverlay;
  if (!overlay?.enabled || !decision?.selected) return null;
  if (!walkForwardPatternMatches(decision.selected.name, overlay.incumbentPatterns || [])) return null;
  const overlayRow = findWalkForwardOverlayRow(trainingRows, decision.selected.name, overlay.overlayPatterns || []);
  if (!overlayRow) return null;
  const candidateResult = periodResultsByParam.get(overlayRow.name)?.[index];
  const incumbentResult = periodResultsByParam.get(decision.selected.name)?.[index];
  const metrics = walkForwardCurrentBasketMetrics(candidateResult, incumbentResult);
  const candidateFreshTrend = metrics.candidateFreshTrend;
  const candidateR20 = metrics.candidateR20;
  const candidateRelativeR20 = basketMetricAverage(candidateResult, "relativeR20");
  const candidateRelativeMomentum = metrics.candidateRelativeMomentum;
  const candidateIndustryResidual = metrics.candidateIndustryResidual;
  const candidateBenchmarkR20 = basketMetricAverage(candidateResult, "benchmarkR20");
  const candidateBenchmarkR60 = basketMetricAverage(candidateResult, "benchmarkR60");
  if (!Number.isFinite(candidateFreshTrend) || candidateFreshTrend < (overlay.minCandidateFreshTrend ?? 66)) return null;
  if (Number.isFinite(overlay.maxCandidateFreshTrend) && candidateFreshTrend > overlay.maxCandidateFreshTrend) return null;
  if (!Number.isFinite(candidateR20) || candidateR20 < (overlay.minCandidateR20 ?? 0.25)) return null;
  if (!Number.isFinite(candidateRelativeR20) || candidateRelativeR20 < (overlay.minCandidateRelativeR20 ?? 0.24)) return null;
  if (
    Number.isFinite(overlay.minCandidateRelativeMomentumScore) &&
    (!Number.isFinite(candidateRelativeMomentum) || candidateRelativeMomentum < overlay.minCandidateRelativeMomentumScore)
  ) return null;
  if (
    Number.isFinite(overlay.minCandidateIndustryResidualScore) &&
    (!Number.isFinite(candidateIndustryResidual) || candidateIndustryResidual < overlay.minCandidateIndustryResidualScore)
  ) return null;
  if (!Number.isFinite(candidateBenchmarkR20) || candidateBenchmarkR20 < (overlay.minCandidateBenchmarkR20 ?? 0)) return null;
  if (Number.isFinite(overlay.maxCandidateBenchmarkR20) && candidateBenchmarkR20 > overlay.maxCandidateBenchmarkR20) return null;
  if (!Number.isFinite(candidateBenchmarkR60) || candidateBenchmarkR60 < (overlay.minCandidateBenchmarkR60 ?? 0.15)) return null;
  if (Number.isFinite(overlay.maxCandidateBenchmarkR60) && candidateBenchmarkR60 > overlay.maxCandidateBenchmarkR60) return null;
  return {
    mode: gate.mode,
    passed: true,
    reason: "fresh_residual_continuation_overlay_applied",
    overlayRow,
    candidateBenchmarkR20,
    candidateBenchmarkR60,
    candidateRelativeR20,
    candidateRelativeMomentum,
    ...metrics,
  };
}

function evaluateWalkForwardBenchmarkMeltupBroadAttackOverlay(decision, periodResultsByParam, index, options = {}, trainingRows = []) {
  const gate = normalizeWalkForwardCurrentBasketGate(options.currentBasketGate);
  const overlay = gate?.benchmarkMeltupBroadAttackOverlay;
  if (!overlay?.enabled || !decision?.selected) return null;
  if (!walkForwardPatternMatches(decision.selected.name, overlay.incumbentPatterns || [])) return null;
  const overlayRow = findWalkForwardOverlayRow(trainingRows, decision.selected.name, overlay.overlayPatterns || []);
  if (!overlayRow) return null;
  const candidateResult = periodResultsByParam.get(overlayRow.name)?.[index];
  const incumbentResult = periodResultsByParam.get(decision.selected.name)?.[index];
  const metrics = walkForwardCurrentBasketMetrics(candidateResult, incumbentResult);
  const candidateBenchmarkR20 = basketMetricAverage(candidateResult, "benchmarkR20");
  const candidateBenchmarkR60 = basketMetricAverage(candidateResult, "benchmarkR60");
  const candidateRelativeR20 = basketMetricAverage(candidateResult, "relativeR20");
  const candidateRelativeMomentum = metrics.candidateRelativeMomentum;
  const candidateFreshTrend = metrics.candidateFreshTrend;
  const candidateIndustryResidual = metrics.candidateIndustryResidual;
  const candidateIndustryResidualRank = metrics.candidateIndustryResidualRank;
  const candidateLotterySpike = basketMetricAverage(candidateResult, "lotterySpikeScore");
  if (!Number.isFinite(candidateBenchmarkR20) || candidateBenchmarkR20 < (overlay.minCandidateBenchmarkR20 ?? 0.20)) return null;
  if (!Number.isFinite(candidateBenchmarkR60) || candidateBenchmarkR60 < (overlay.minCandidateBenchmarkR60 ?? 0.35)) return null;
  if (!Number.isFinite(candidateRelativeR20) || candidateRelativeR20 < (overlay.minCandidateRelativeR20 ?? 0.10)) return null;
  if (
    Number.isFinite(overlay.minCandidateRelativeMomentumScore) &&
    (!Number.isFinite(candidateRelativeMomentum) || candidateRelativeMomentum < overlay.minCandidateRelativeMomentumScore)
  ) return null;
  if (!Number.isFinite(candidateFreshTrend) || candidateFreshTrend < (overlay.minCandidateFreshTrend ?? 60)) return null;
  if (Number.isFinite(overlay.maxCandidateFreshTrend) && candidateFreshTrend > overlay.maxCandidateFreshTrend) return null;
  if (
    Number.isFinite(overlay.maxCandidateIndustryResidualScore) &&
    (!Number.isFinite(candidateIndustryResidual) || candidateIndustryResidual > overlay.maxCandidateIndustryResidualScore)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateIndustryResidualRankScore) &&
    (!Number.isFinite(candidateIndustryResidualRank) || candidateIndustryResidualRank > overlay.maxCandidateIndustryResidualRankScore)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateLotterySpikeScore) &&
    (!Number.isFinite(candidateLotterySpike) || candidateLotterySpike > overlay.maxCandidateLotterySpikeScore)
  ) return null;
  return {
    mode: gate.mode,
    passed: true,
    reason: "benchmark_meltup_broad_attack_overlay_applied",
    overlayRow,
    candidateBenchmarkR20,
    candidateBenchmarkR60,
    candidateRelativeR20,
    candidateRelativeMomentum,
    candidateIndustryResidualRankScore: candidateIndustryResidualRank,
    lotteryGuardScore: candidateLotterySpike,
    ...metrics,
  };
}

function evaluateWalkForwardBenchmarkEarlyBroadAttackOverlay(decision, periodResultsByParam, index, options = {}, trainingRows = []) {
  const gate = normalizeWalkForwardCurrentBasketGate(options.currentBasketGate);
  const overlay = gate?.benchmarkEarlyBroadAttackOverlay;
  if (!overlay?.enabled || !decision?.selected) return null;
  if (!walkForwardPatternMatches(decision.selected.name, overlay.incumbentPatterns || [])) return null;
  const overlayRow = findWalkForwardOverlayRow(trainingRows, decision.selected.name, overlay.overlayPatterns || []);
  if (!overlayRow) return null;
  const candidateResult = periodResultsByParam.get(overlayRow.name)?.[index];
  const incumbentResult = periodResultsByParam.get(decision.selected.name)?.[index];
  const metrics = walkForwardCurrentBasketMetrics(candidateResult, incumbentResult);
  const candidateBenchmarkR20 = basketMetricAverage(candidateResult, "benchmarkR20");
  const candidateBenchmarkR60 = basketMetricAverage(candidateResult, "benchmarkR60");
  const candidateRelativeR20 = basketMetricAverage(candidateResult, "relativeR20");
  const candidateRelativeMomentum = metrics.candidateRelativeMomentum;
  const candidateFreshTrend = metrics.candidateFreshTrend;
  const candidateIndustryResidualRank = metrics.candidateIndustryResidualRank;
  const candidateLotterySpike = basketMetricAverage(candidateResult, "lotterySpikeScore");
  if (!Number.isFinite(candidateBenchmarkR20) || candidateBenchmarkR20 < (overlay.minCandidateBenchmarkR20 ?? 0.08)) return null;
  if (Number.isFinite(overlay.maxCandidateBenchmarkR20) && candidateBenchmarkR20 > overlay.maxCandidateBenchmarkR20) return null;
  if (!Number.isFinite(candidateBenchmarkR60) || candidateBenchmarkR60 < (overlay.minCandidateBenchmarkR60 ?? 0.10)) return null;
  if (Number.isFinite(overlay.maxCandidateBenchmarkR60) && candidateBenchmarkR60 > overlay.maxCandidateBenchmarkR60) return null;
  if (!Number.isFinite(candidateRelativeR20) || candidateRelativeR20 < (overlay.minCandidateRelativeR20 ?? 0.20)) return null;
  if (
    Number.isFinite(overlay.minCandidateRelativeMomentumScore) &&
    (!Number.isFinite(candidateRelativeMomentum) || candidateRelativeMomentum < overlay.minCandidateRelativeMomentumScore)
  ) return null;
  if (!Number.isFinite(candidateFreshTrend) || candidateFreshTrend < (overlay.minCandidateFreshTrend ?? 74)) return null;
  if (Number.isFinite(overlay.maxCandidateFreshTrend) && candidateFreshTrend > overlay.maxCandidateFreshTrend) return null;
  if (
    Number.isFinite(overlay.maxCandidateIndustryResidualRankScore) &&
    (!Number.isFinite(candidateIndustryResidualRank) || candidateIndustryResidualRank > overlay.maxCandidateIndustryResidualRankScore)
  ) return null;
  if (
    Number.isFinite(overlay.maxCandidateLotterySpikeScore) &&
    (!Number.isFinite(candidateLotterySpike) || candidateLotterySpike > overlay.maxCandidateLotterySpikeScore)
  ) return null;
  return {
    mode: gate.mode,
    passed: true,
    reason: "benchmark_early_broad_attack_overlay_applied",
    overlayRow,
    candidateBenchmarkR20,
    candidateBenchmarkR60,
    candidateRelativeR20,
    candidateRelativeMomentum,
    candidateIndustryResidualRankScore: candidateIndustryResidualRank,
    lotteryGuardScore: candidateLotterySpike,
    ...metrics,
  };
}

function evaluateWalkForwardFreshDecayCrashOverlay(decision, periodResultsByParam, index, options = {}, trainingRows = []) {
  const gate = normalizeWalkForwardCurrentBasketGate(options.currentBasketGate);
  const overlay = gate?.freshDecayCrashOverlay;
  if (!overlay?.enabled || !decision?.selected) return null;
  const selectedName = decision.selected.name;
  const selectedMatchesFresh = walkForwardPatternMatches(selectedName, overlay.freshPatterns || []);
  const selectedMatchesMature = walkForwardPatternMatches(selectedName, overlay.maturePatterns || []);
  if (!selectedMatchesFresh && !selectedMatchesMature) return null;
  const overlayPatterns = selectedMatchesMature
    ? overlay.matureOverlayPatterns || []
    : overlay.freshOverlayPatterns || [];
  const overlayRow = findWalkForwardOverlayRow(trainingRows, selectedName, overlayPatterns);
  if (!overlayRow) return null;
  const selectedResult = periodResultsByParam.get(selectedName)?.[index];
  const selectedBenchmarkR20 = basketMetricAverage(selectedResult, "benchmarkR20");
  const selectedBenchmarkR60 = basketMetricAverage(selectedResult, "benchmarkR60");
  if (!Number.isFinite(selectedBenchmarkR20) || selectedBenchmarkR20 < (overlay.minSelectedBenchmarkR20 ?? 0.04)) return null;
  if (Number.isFinite(overlay.maxSelectedBenchmarkR20) && selectedBenchmarkR20 > overlay.maxSelectedBenchmarkR20) return null;
  if (!Number.isFinite(selectedBenchmarkR60) || selectedBenchmarkR60 < (overlay.minSelectedBenchmarkR60 ?? 0.18)) return null;
  const overlayResult = periodResultsByParam.get(overlayRow.name)?.[index];
  const cashWeight = Number(overlayResult?.exhaustionCashWeight ?? overlayResult?.defensiveCashWeight);
  if (!Number.isFinite(cashWeight) || cashWeight < (overlay.minCashWeight ?? 0.05)) return null;
  return {
    mode: gate.mode,
    passed: true,
    reason: "fresh_decay_crash_overlay_applied",
    overlayRow,
    candidateBenchmarkR20: selectedBenchmarkR20,
    candidateBenchmarkR60: selectedBenchmarkR60,
    exhaustionCashWeight: Number(overlayResult?.exhaustionCashWeight) || 0,
    defensiveCashWeight: Number(overlayResult?.defensiveCashWeight) || 0,
  };
}

function applyWalkForwardFreshDecayCrashOverlay(decision, periodResultsByParam, index, options = {}, trainingRows = []) {
  const freshDecayCrashResult = evaluateWalkForwardFreshDecayCrashOverlay(decision, periodResultsByParam, index, options, trainingRows);
  if (!freshDecayCrashResult) return null;
  return {
    decision: {
      ...decision,
      selected: freshDecayCrashResult.overlayRow,
      selectionReason: "switched_current_fresh_decay_crash_overlay",
    },
    gateResult: freshDecayCrashResult,
  };
}

function applyWalkForwardCurrentBasketGateWithRows(decision, periodResultsByParam, index, options = {}, trainingRows = [], selections = []) {
  const gateResult = evaluateWalkForwardCurrentBasketGate(decision, periodResultsByParam, index, options);
  const gate = normalizeWalkForwardCurrentBasketGate(options.currentBasketGate);
  if (
    gateResult &&
    !gateResult.passed &&
    gate?.benchmarkStateAttackGate?.preserveRecoveryBeforeBlock &&
    String(gateResult.reason || "").includes("attack_benchmark_positive_industry_residual_advantage_below_min")
  ) {
    const recoveryBeforeBlock = evaluateWalkForwardRecoveryOverlay(decision, periodResultsByParam, index, options, trainingRows, selections);
    if (recoveryBeforeBlock) {
      const nextDecision = {
        ...decision,
        selected: recoveryBeforeBlock.overlayRow,
        selectionReason: "switched_current_recovery_overlay",
      };
      return applyWalkForwardBetaRecoveryHighConvictionOverlay(nextDecision, periodResultsByParam, index, options, trainingRows) || {
        decision: nextDecision,
        gateResult: recoveryBeforeBlock,
      };
    }
  }
  const gatedDecision = !gateResult || gateResult.passed
    ? decision
    : {
      ...decision,
      selected: decision.incumbent,
      selectionReason: "kept_incumbent_current_gate",
    };
  const benchmarkPullbackVolumeMomentumResult = applyWalkForwardBenchmarkPullbackVolumeMomentumOverlay(gatedDecision, periodResultsByParam, index, options, trainingRows);
  if (benchmarkPullbackVolumeMomentumResult) return benchmarkPullbackVolumeMomentumResult;
  const benchmarkPullbackResidualVolumeMomentumResult = applyWalkForwardBenchmarkPullbackResidualVolumeMomentumOverlay(gatedDecision, periodResultsByParam, index, options, trainingRows);
  if (benchmarkPullbackResidualVolumeMomentumResult) return benchmarkPullbackResidualVolumeMomentumResult;
  const benchmarkPullbackAttackResult = evaluateWalkForwardBenchmarkPullbackAttackOverlay(gatedDecision, periodResultsByParam, index, options, trainingRows);
  if (benchmarkPullbackAttackResult) {
    const nextDecision = {
      ...gatedDecision,
      selected: benchmarkPullbackAttackResult.overlayRow,
      selectionReason: "switched_current_benchmark_pullback_attack_overlay",
    };
    return applyWalkForwardBenchmarkPullbackReversalStabilityOverlay(nextDecision, periodResultsByParam, index, options, trainingRows) ||
      applyWalkForwardBenchmarkPullbackVolumeMomentumOverlay(nextDecision, periodResultsByParam, index, options, trainingRows) ||
      applyWalkForwardBenchmarkPullbackResidualVolumeMomentumOverlay(nextDecision, periodResultsByParam, index, options, trainingRows) || {
      decision: nextDecision,
      gateResult: benchmarkPullbackAttackResult,
    };
  }
  const benchmarkMeltupBroadAttackResult = evaluateWalkForwardBenchmarkMeltupBroadAttackOverlay(gatedDecision, periodResultsByParam, index, options, trainingRows);
  if (benchmarkMeltupBroadAttackResult) {
    return {
      decision: {
        ...gatedDecision,
        selected: benchmarkMeltupBroadAttackResult.overlayRow,
        selectionReason: "switched_current_benchmark_meltup_broad_attack_overlay",
      },
      gateResult: benchmarkMeltupBroadAttackResult,
    };
  }
  const benchmarkEarlyBroadAttackResult = evaluateWalkForwardBenchmarkEarlyBroadAttackOverlay(gatedDecision, periodResultsByParam, index, options, trainingRows);
  if (benchmarkEarlyBroadAttackResult) {
    return {
      decision: {
        ...gatedDecision,
        selected: benchmarkEarlyBroadAttackResult.overlayRow,
        selectionReason: "switched_current_benchmark_early_broad_attack_overlay",
      },
      gateResult: benchmarkEarlyBroadAttackResult,
    };
  }
  const freshOverextensionMatureFallbackResult = evaluateWalkForwardFreshOverextensionMatureFallbackOverlay(gatedDecision, periodResultsByParam, index, options, trainingRows);
  if (freshOverextensionMatureFallbackResult) {
    const nextDecision = {
      ...gatedDecision,
      selected: freshOverextensionMatureFallbackResult.overlayRow,
      selectionReason: "switched_current_fresh_overextension_mature_fallback_overlay",
    };
    const freshOverextensionReversalStabilityResult = applyWalkForwardFreshOverextensionReversalStabilityOverlay(nextDecision, periodResultsByParam, index, options, trainingRows);
    if (freshOverextensionReversalStabilityResult) return freshOverextensionReversalStabilityResult;
    return applyWalkForwardFreshDecayCrashOverlay(nextDecision, periodResultsByParam, index, options, trainingRows) || {
      decision: nextDecision,
      gateResult: freshOverextensionMatureFallbackResult,
    };
  }
  const freshResidualContinuationResult = evaluateWalkForwardFreshResidualContinuationOverlay(gatedDecision, periodResultsByParam, index, options, trainingRows);
  if (freshResidualContinuationResult) {
    return {
      decision: {
        ...gatedDecision,
        selected: freshResidualContinuationResult.overlayRow,
        selectionReason: "switched_current_fresh_residual_continuation_overlay",
      },
      gateResult: freshResidualContinuationResult,
    };
  }
  const directFreshLotteryGuardResult = applyWalkForwardDirectFreshLotteryGuardOverlay(gatedDecision, periodResultsByParam, index, options, trainingRows);
  if (directFreshLotteryGuardResult) return directFreshLotteryGuardResult;
  const freshReversalStabilityResult = applyWalkForwardFreshReversalStabilityOverlay(gatedDecision, periodResultsByParam, index, options, trainingRows);
  if (freshReversalStabilityResult) return freshReversalStabilityResult;
  const freshVolumeMomentumResult = applyWalkForwardFreshVolumeMomentumOverlay(gatedDecision, periodResultsByParam, index, options, trainingRows);
  if (freshVolumeMomentumResult) return freshVolumeMomentumResult;
  const broadPoolReversalStabilityResult = applyWalkForwardBroadPoolReversalStabilityOverlay(gatedDecision, periodResultsByParam, index, options, trainingRows);
  if (broadPoolReversalStabilityResult) return broadPoolReversalStabilityResult;
  const incumbentReversalStabilityResult = applyWalkForwardIncumbentReversalStabilityOverlay(gatedDecision, periodResultsByParam, index, options, trainingRows);
  if (incumbentReversalStabilityResult) return incumbentReversalStabilityResult;
  const broadPoolVolumeMomentumResult = applyWalkForwardBroadPoolVolumeMomentumOverlay(gatedDecision, periodResultsByParam, index, options, trainingRows);
  if (broadPoolVolumeMomentumResult) return broadPoolVolumeMomentumResult;
  const narrowNoStaticMeltupResult = applyWalkForwardNarrowNoStaticMeltupOverlay(gatedDecision, periodResultsByParam, index, options, trainingRows);
  if (narrowNoStaticMeltupResult) return narrowNoStaticMeltupResult;
  const freshRotationResult = evaluateWalkForwardFreshRotationOverlay(gatedDecision, periodResultsByParam, index, options, trainingRows);
  if (freshRotationResult) {
    const nextDecision = {
      ...gatedDecision,
      selected: freshRotationResult.overlayRow,
      selectionReason: freshRotationResult.reason === "fresh_rotation_lottery_guard_overlay_applied"
        ? "switched_current_fresh_rotation_lottery_guard_overlay"
        : "switched_current_fresh_rotation_overlay",
    };
    const freshRotationReversalStabilityResult = applyWalkForwardFreshRotationReversalStabilityOverlay(nextDecision, periodResultsByParam, index, options, trainingRows);
    if (freshRotationReversalStabilityResult) return freshRotationReversalStabilityResult;
    return applyWalkForwardFreshDecayCrashOverlay(nextDecision, periodResultsByParam, index, options, trainingRows) || {
      decision: nextDecision,
      gateResult: freshRotationResult,
    };
  }
  const overlayResult = evaluateWalkForwardExhaustionOverlay(gatedDecision, periodResultsByParam, index, options, trainingRows);
  if (overlayResult) {
    return {
      decision: {
        ...gatedDecision,
        selected: overlayResult.overlayRow,
        selectionReason: "switched_current_exhaustion_overlay",
      },
      gateResult: overlayResult,
    };
  }
  const recoveryResult = evaluateWalkForwardRecoveryOverlay(gatedDecision, periodResultsByParam, index, options, trainingRows, selections);
  if (recoveryResult) {
    const nextDecision = {
      ...gatedDecision,
      selected: recoveryResult.overlayRow,
      selectionReason: "switched_current_recovery_overlay",
    };
    return applyWalkForwardBetaRecoveryHighConvictionOverlay(nextDecision, periodResultsByParam, index, options, trainingRows) || {
      decision: nextDecision,
      gateResult: recoveryResult,
    };
  }
  const pullbackCatchupResult = evaluateWalkForwardPullbackCatchupOverlay(gatedDecision, periodResultsByParam, index, options, trainingRows);
  if (pullbackCatchupResult) {
    const nextDecision = {
      ...gatedDecision,
      selected: pullbackCatchupResult.overlayRow,
      selectionReason: "switched_current_pullback_catchup_overlay",
    };
    const betaBoostDecision = applyWalkForwardPullbackBetaBoostOverlay(nextDecision, periodResultsByParam, index, options, trainingRows);
    if (betaBoostDecision) {
      return applyWalkForwardBetaRecoveryHighConvictionOverlay(betaBoostDecision.decision, periodResultsByParam, index, options, trainingRows) || betaBoostDecision;
    }
    return {
      decision: nextDecision,
      gateResult: pullbackCatchupResult,
    };
  }
  const freshDecayCrashResult = applyWalkForwardFreshDecayCrashOverlay(gatedDecision, periodResultsByParam, index, options, trainingRows);
  if (freshDecayCrashResult) return freshDecayCrashResult;
  return {
    decision: gatedDecision,
    gateResult,
  };
}

function walkForwardIncumbentName(currentIncumbentName, options = {}) {
  if (options.incumbentPolicy === "stable" && options.stableParamName) {
    return options.stableParamName;
  }
  return currentIncumbentName;
}

function walkForwardSelectionTrainingRows(trainingRows, options = {}) {
  const gate = normalizeWalkForwardCurrentBasketGate(options.currentBasketGate);
  const overlayPatterns = [
    ...(gate?.exhaustionOverlay?.enabled && gate.exhaustionOverlay.overlayOnly !== false ? gate.exhaustionOverlay.overlayPatterns || [] : []),
    ...(gate?.recoveryOverlay?.enabled && gate.recoveryOverlay.overlayOnly !== false ? gate.recoveryOverlay.overlayPatterns || [] : []),
    ...(gate?.pullbackCatchupOverlay?.enabled && gate.pullbackCatchupOverlay.overlayOnly !== false ? gate.pullbackCatchupOverlay.overlayPatterns || [] : []),
    ...(gate?.pullbackBetaBoostOverlay?.enabled && gate.pullbackBetaBoostOverlay.overlayOnly !== false ? gate.pullbackBetaBoostOverlay.overlayPatterns || [] : []),
    ...(gate?.betaRecoveryHighConvictionOverlay?.enabled && gate.betaRecoveryHighConvictionOverlay.overlayOnly !== false ? gate.betaRecoveryHighConvictionOverlay.overlayPatterns || [] : []),
    ...(gate?.directFreshLotteryGuardOverlay?.enabled && gate.directFreshLotteryGuardOverlay.overlayOnly !== false ? gate.directFreshLotteryGuardOverlay.overlayPatterns || [] : []),
    ...(gate?.freshReversalStabilityOverlay?.enabled && gate.freshReversalStabilityOverlay.overlayOnly !== false ? gate.freshReversalStabilityOverlay.overlayPatterns || [] : []),
    ...(gate?.freshVolumeMomentumOverlay?.enabled && gate.freshVolumeMomentumOverlay.overlayOnly !== false ? gate.freshVolumeMomentumOverlay.overlayPatterns || [] : []),
    ...(gate?.broadPoolReversalStabilityOverlay?.enabled && gate.broadPoolReversalStabilityOverlay.overlayOnly !== false ? gate.broadPoolReversalStabilityOverlay.overlayPatterns || [] : []),
    ...(gate?.incumbentReversalStabilityOverlay?.enabled && gate.incumbentReversalStabilityOverlay.overlayOnly !== false ? gate.incumbentReversalStabilityOverlay.overlayPatterns || [] : []),
    ...(gate?.benchmarkPullbackVolumeMomentumOverlay?.enabled && gate.benchmarkPullbackVolumeMomentumOverlay.overlayOnly !== false ? gate.benchmarkPullbackVolumeMomentumOverlay.overlayPatterns || [] : []),
    ...(gate?.benchmarkPullbackResidualVolumeMomentumOverlay?.enabled && gate.benchmarkPullbackResidualVolumeMomentumOverlay.overlayOnly !== false ? gate.benchmarkPullbackResidualVolumeMomentumOverlay.overlayPatterns || [] : []),
    ...(gate?.benchmarkPullbackReversalStabilityOverlay?.enabled && gate.benchmarkPullbackReversalStabilityOverlay.overlayOnly !== false ? gate.benchmarkPullbackReversalStabilityOverlay.overlayPatterns || [] : []),
    ...(gate?.broadPoolVolumeMomentumOverlay?.enabled && gate.broadPoolVolumeMomentumOverlay.overlayOnly !== false ? gate.broadPoolVolumeMomentumOverlay.overlayPatterns || [] : []),
    ...(gate?.narrowNoStaticMeltupOverlay?.enabled && gate.narrowNoStaticMeltupOverlay.overlayOnly !== false ? gate.narrowNoStaticMeltupOverlay.overlayPatterns || [] : []),
    ...(gate?.freshRotationReversalStabilityOverlay?.enabled && gate.freshRotationReversalStabilityOverlay.overlayOnly !== false ? gate.freshRotationReversalStabilityOverlay.overlayPatterns || [] : []),
    ...(gate?.freshOverextensionReversalStabilityOverlay?.enabled && gate.freshOverextensionReversalStabilityOverlay.overlayOnly !== false ? gate.freshOverextensionReversalStabilityOverlay.overlayPatterns || [] : []),
    ...(gate?.freshRotationOverlay?.enabled && gate.freshRotationOverlay.lotteryGuardOverlayOnly !== false ? gate.freshRotationOverlay.lotteryGuardOverlayPatterns || [] : []),
    ...(gate?.freshDecayCrashOverlay?.enabled ? [
      ...(gate.freshDecayCrashOverlay.freshOverlayPatterns || []),
      ...(gate.freshDecayCrashOverlay.matureOverlayPatterns || []),
    ] : []),
  ];
  const overlayOnlyParamNames = new Set(paramGrid()
    .filter((params) => params.walkForwardOverlayOnly)
    .map((params) => params.name));
  return trainingRows.filter((row) => {
    const baseName = baseWalkForwardParamName(row.name);
    if (overlayOnlyParamNames.has(row.name) || overlayOnlyParamNames.has(baseName)) return false;
    return !walkForwardPatternMatches(row.name, overlayPatterns);
  });
}

function walkForwardOptimize(periodResultsByParam, options = {}) {
  const minTrainPeriods = options.minTrainPeriods ?? 3;
  const names = Array.from(periodResultsByParam.keys());
  if (!names.length) return [];
  const periodCount = Math.min(...names.map((name) => periodResultsByParam.get(name).length));
  const selections = [];
  let incumbentName = options.stableParamName || null;
  for (let index = minTrainPeriods; index < periodCount; index += 1) {
    const rawTrainingRows = walkForwardTrainingRows(periodResultsByParam, names, index, options);
    const { rows: trainingRows, filteredParamCount } = eligibleWalkForwardTrainingRows(rawTrainingRows, index, options);
    const selectionTrainingRows = walkForwardSelectionTrainingRows(trainingRows, options);
    if (options.knownOutcomeOnly) {
      const bestKnownTrainingPeriods = Math.max(...selectionTrainingRows.map((row) => row.trainingPeriods || 0), 0);
      if (bestKnownTrainingPeriods < minTrainPeriods) continue;
    }
    const decision = selectWalkForwardTrainingRow(
      selectionTrainingRows,
      walkForwardIncumbentName(incumbentName, options),
      options
    );
    const gated = applyWalkForwardCurrentBasketGateWithRows(decision, periodResultsByParam, index, options, rawTrainingRows, selections);
    const finalDecision = gated.decision;
    const currentGate = gated.gateResult;
    const selected = finalDecision?.selected;
    if (!selected) continue;
    incumbentName = options.incumbentPolicy === "stable" && options.stableParamName
      ? options.stableParamName
      : selected.name;
    const result = periodResultsByParam.get(selected.name)[index];
    selections.push({
      periodIndex: index,
      period: `${result.asOf}:${result.end}`,
      asOf: result.asOf,
      end: result.end,
      selectedParam: selected.name,
      candidateParam: finalDecision.candidate?.name ?? null,
      incumbentParam: finalDecision.incumbent?.name ?? null,
      selectionReason: finalDecision.selectionReason,
      candidateTrainingScore: finalDecision.candidate?.trainingScore ?? null,
      candidateScoreAdvantage: finalDecision.candidateScoreAdvantage,
      currentGateMode: currentGate?.mode ?? null,
      currentGatePassed: currentGate?.passed ?? null,
      currentGateReason: currentGate?.reason ?? null,
      currentGateFreshTrendAdvantage: currentGate?.freshTrendAdvantage ?? null,
      currentGateR20Advantage: currentGate?.r20Advantage ?? null,
      currentGateRelativeMomentumAdvantage: currentGate?.relativeMomentumAdvantage ?? null,
      currentGateIndustryResidualAdvantage: currentGate?.industryResidualAdvantage ?? null,
      currentGateIndustryResidualRankScore: currentGate?.candidateIndustryResidualRankScore ?? currentGate?.candidateIndustryResidualRank ?? null,
      currentGateFreshTrend: currentGate?.freshTrend ?? currentGate?.candidateFreshTrend ?? null,
      currentGateShortTermReversalScore: currentGate?.shortTermReversalScore ?? null,
      currentGateTurnoverStabilityScore: currentGate?.turnoverStabilityScore ?? null,
      currentGateVolumeMomentumScore: currentGate?.volumeMomentumScore ?? null,
      currentGateVolumeTurnoverRatio: currentGate?.volumeTurnoverRatio ?? null,
      currentGateLotteryGuardScore: currentGate?.lotteryGuardScore ?? null,
      currentGateLotteryGuardFreshTrend: currentGate?.lotteryGuardFreshTrend ?? null,
      currentGateBenchmarkR20: currentGate?.candidateBenchmarkR20 ?? null,
      currentGateBenchmarkR60: currentGate?.candidateBenchmarkR60 ?? null,
      currentGateRelativeR20: currentGate?.candidateRelativeR20 ?? currentGate?.currentRelativeR20 ?? null,
      currentGateRelativeMomentum: currentGate?.candidateRelativeMomentum ?? currentGate?.currentRelativeMomentum ?? null,
      currentGateEntryDayReturn: currentGate?.candidateEntryDayReturn ?? null,
      currentGateMaxDailyReturn20: currentGate?.candidateMaxDailyReturn20 ?? null,
      currentGateVol20: currentGate?.candidateVol20 ?? null,
      currentGateIndustryBreadth20: currentGate?.candidateIndustryBreadth20 ?? null,
      eligibleParamCount: selectionTrainingRows.length,
      filteredParamCount: filteredParamCount + (trainingRows.length - selectionTrainingRows.length),
      trainingScore: selected.trainingScore,
      trainingAvgReturn: selected.trainingAvgReturn,
      trainingAvgExcess: selected.trainingAvgExcess,
      trainingHitRate: selected.trainingHitRate,
      trainingPeriods: selected.trainingPeriods,
      trainingReturnVol: selected.trainingReturnVol,
      trainingExcessVol: selected.trainingExcessVol,
      trainingReturnDownside: selected.trainingReturnDownside,
      trainingExcessDownside: selected.trainingExcessDownside,
      trainingWorstReturn: selected.trainingWorstReturn,
      trainingWorstExcess: selected.trainingWorstExcess,
      adaptiveWeightedTopReturn: result.adaptiveWeightedTopReturn,
      netAdaptiveWeightedTopReturn: result.netAdaptiveWeightedTopReturn,
      weightedTopReturn: result.weightedTopReturn,
      netWeightedTopReturn: result.netWeightedTopReturn,
      topMeanReturn: result.topMeanReturn,
      netTopMeanReturn: result.netTopMeanReturn,
      universeMeanReturn: result.universeMeanReturn,
      netUniverseMeanReturn: result.netUniverseMeanReturn,
      weightedBenchmarkReturn: result.weightedBenchmarkReturn,
      netWeightedBenchmarkReturn: result.netWeightedBenchmarkReturn,
      benchmarkOverlayWeight: result.benchmarkOverlayWeight,
      defensiveCashWeight: result.defensiveCashWeight,
      weakMarketCashWeight: result.weakMarketCashWeight,
      exhaustionCashWeight: result.exhaustionCashWeight,
      adaptiveExcessVsBenchmark: result.adaptiveExcessVsBenchmark,
      netAdaptiveExcessVsBenchmark: result.netAdaptiveExcessVsBenchmark,
      weightedExcessVsBenchmark: result.weightedExcessVsBenchmark,
      netWeightedExcessVsBenchmark: result.netWeightedExcessVsBenchmark,
      adaptiveWeightedExcessReturn: result.adaptiveWeightedExcessReturn,
      netAdaptiveWeightedExcessReturn: result.netAdaptiveWeightedExcessReturn,
      pValue: result.welchTopVsRest?.pValue ?? null,
      scoredCount: result.scoredCount,
      skippedCount: result.skippedCount,
    });
  }
  return selections;
}

function normalizePoolRowsByName(rowsByPool) {
  if (rowsByPool instanceof Map) return Array.from(rowsByPool.entries());
  return Object.entries(rowsByPool || {});
}

function walkForwardPoolTrainingRows(rowsByPool, poolNames, index, options = {}) {
  const lookbackPeriods = Number.isFinite(options.lookbackPeriods) && options.lookbackPeriods > 0
    ? Math.floor(options.lookbackPeriods)
    : index;
  const start = Math.max(0, index - lookbackPeriods);
  const excessWeight = Number.isFinite(options.scoreExcessWeight) ? options.scoreExcessWeight : 0.35;
  const currentAsOf = currentAsOfForIndex(rowsByPool, poolNames, index);
  return poolNames.map((name) => {
    const rawTrainingResults = (rowsByPool.get(name) || []).slice(start, index);
    const trainingResults = options.knownOutcomeOnly
      ? rawTrainingResults.filter((row) => isKnownBeforeAsOf(row, currentAsOf))
      : rawTrainingResults;
    const trainingReturns = trainingResults.map((row) => Number(resultObjectiveReturn(row))).filter((value) => Number.isFinite(value));
    const trainingExcess = trainingResults.map((row) => Number(resultObjectiveExcess(row))).filter((value) => Number.isFinite(value));
    const trainingAvgReturn = mean(trainingReturns);
    const trainingAvgExcess = mean(trainingExcess);
    return {
      name,
      trainingAvgReturn,
      trainingAvgExcess,
      trainingScore: (trainingAvgReturn ?? -0.5) + excessWeight * (trainingAvgExcess ?? -0.5),
      trainingPeriods: Math.min(trainingReturns.length, trainingExcess.length),
      trainingLookbackPeriods: index - start,
      trainingReturnVol: stddev(trainingReturns),
      trainingExcessVol: stddev(trainingExcess),
      trainingWorstReturn: trainingReturns.length ? Math.min(...trainingReturns) : null,
      trainingWorstExcess: trainingExcess.length ? Math.min(...trainingExcess) : null,
    };
  }).sort((a, b) => (b.trainingScore ?? -Infinity) - (a.trainingScore ?? -Infinity));
}

function walkForwardPoolSelect(rowsByPoolInput, options = {}) {
  const entries = normalizePoolRowsByName(rowsByPoolInput);
  const rowsByPool = new Map(entries.map(([name, rows]) => [name, rows || []]));
  const poolNames = Array.from(rowsByPool.keys());
  if (!poolNames.length) return [];
  const minTrainPeriods = options.minTrainPeriods ?? 3;
  const switchMargin = Number.isFinite(Number(options.switchMargin)) ? Math.max(0, Number(options.switchMargin)) : 0;
  const incumbentPolicy = options.incumbentPolicy || "off";
  const periodCount = Math.min(...poolNames.map((name) => rowsByPool.get(name).length));
  const selections = [];
  const fallbackName = options.initialPool && rowsByPool.has(options.initialPool) ? options.initialPool : poolNames[0];
  let incumbentPool = fallbackName;
  const startIndex = options.includeWarmup ? 0 : minTrainPeriods;
  for (let index = startIndex; index < periodCount; index += 1) {
    const hasIndexedTraining = index >= minTrainPeriods;
    const trainingRows = hasIndexedTraining ? walkForwardPoolTrainingRows(rowsByPool, poolNames, index, options) : [];
    const candidate = trainingRows[0] || null;
    const hasTraining = hasIndexedTraining &&
      (!options.knownOutcomeOnly || ((candidate?.trainingPeriods || 0) >= minTrainPeriods));
    if (
      options.knownOutcomeOnly &&
      !options.includeWarmup &&
      hasIndexedTraining &&
      (!candidate || (candidate.trainingPeriods || 0) < minTrainPeriods)
    ) {
      continue;
    }
    let selected = hasTraining ? candidate : null;
    let poolSelectionReason = hasTraining
      ? (candidate?.trainingPeriods > 0 ? "selected_by_prior_pool_score" : "kept_initial_pool")
      : "warmup_initial_pool";
    let incumbentTrainingRow = null;
    let poolScoreAdvantage = null;
    if (
      hasTraining &&
      incumbentPolicy === "rolling" &&
      switchMargin > 0 &&
      candidate?.trainingPeriods > 0 &&
      incumbentPool &&
      candidate.name !== incumbentPool
    ) {
      incumbentTrainingRow = trainingRows.find((row) => row.name === incumbentPool) || null;
      if (incumbentTrainingRow?.trainingPeriods > 0) {
        poolScoreAdvantage = candidate.trainingScore - incumbentTrainingRow.trainingScore;
        if (poolScoreAdvantage < switchMargin) {
          selected = incumbentTrainingRow;
          poolSelectionReason = "kept_incumbent_margin";
        }
      }
    }
    const selectedPool = hasTraining && selected?.trainingPeriods > 0 ? selected.name : fallbackName;
    const result = rowsByPool.get(selectedPool)?.[index];
    if (!result) continue;
    selections.push({
      ...result,
      periodIndex: result.periodIndex ?? index,
      period: result.period || `${result.asOf}:${result.end}`,
      selectedPool,
      selectedPoolParam: result.selectedParam ?? null,
      poolSelectionReason,
      candidatePool: candidate?.name ?? null,
      candidatePoolTrainingScore: candidate?.trainingScore ?? null,
      incumbentPool: incumbentTrainingRow?.name ?? null,
      incumbentPoolTrainingScore: incumbentTrainingRow?.trainingScore ?? null,
      poolScoreAdvantage,
      eligiblePoolCount: trainingRows.length,
      trainingScore: selected?.trainingScore ?? null,
      trainingAvgReturn: selected?.trainingAvgReturn ?? null,
      trainingAvgExcess: selected?.trainingAvgExcess ?? null,
      trainingPeriods: selected?.trainingPeriods ?? 0,
      trainingLookbackPeriods: selected?.trainingLookbackPeriods ?? 0,
      trainingReturnVol: selected?.trainingReturnVol ?? null,
      trainingExcessVol: selected?.trainingExcessVol ?? null,
      trainingWorstReturn: selected?.trainingWorstReturn ?? null,
      trainingWorstExcess: selected?.trainingWorstExcess ?? null,
    });
    if (incumbentPolicy === "rolling") {
      incumbentPool = selectedPool;
    }
  }
  return selections;
}

function normalizeEnsembleWeights(selectedRows, options = {}) {
  if (!selectedRows.length) return [];
  if (options.weighting === "score") {
    const temperature = options.scoreTemperature ?? 20;
    const maxScore = Math.max(...selectedRows.map((row) => Number(row.trainingScore)).filter(Number.isFinite));
    const raw = selectedRows.map((row) => {
      const score = Number(row.trainingScore);
      return Number.isFinite(score) && Number.isFinite(maxScore) ? Math.exp((score - maxScore) * temperature) : 1;
    });
    const total = raw.reduce((sum, value) => sum + value, 0) || raw.length;
    return raw.map((value) => value / total);
  }
  if (options.weighting === "risk") {
    const riskFloor = options.riskFloor ?? 0.035;
    const raw = selectedRows.map((row) => {
      const expectedReturn = Math.max(0, Number(row.trainingAvgReturn) || 0);
      const expectedExcess = Math.max(0, Number(row.trainingAvgExcess) || 0);
      const hitRate = Number.isFinite(Number(row.trainingHitRate)) ? Number(row.trainingHitRate) : 0.5;
      const returnVol = Math.max(0, Number(row.trainingReturnVol) || 0);
      const excessVol = Math.max(0, Number(row.trainingExcessVol) || 0);
      const returnDownside = Math.max(0, Number(row.trainingReturnDownside) || 0);
      const excessDownside = Math.max(0, Number(row.trainingExcessDownside) || 0);
      const worstReturnLoss = Math.max(0, -(Number(row.trainingWorstReturn) || 0));
      const worstExcessLoss = Math.max(0, -(Number(row.trainingWorstExcess) || 0));
      const reward = Math.max(0.01, expectedReturn * 0.50 + expectedExcess * 0.20 + hitRate * 0.02);
      const risk = riskFloor +
        returnVol * 0.60 +
        excessVol * 0.30 +
        returnDownside * 1.40 +
        excessDownside * 0.70 +
        worstReturnLoss * 0.80 +
        worstExcessLoss * 0.50;
      return reward / Math.max(riskFloor, risk);
    });
    const total = raw.reduce((sum, value) => sum + value, 0) || raw.length;
    return raw.map((value) => value / total);
  }
  return selectedRows.map(() => 1 / selectedRows.length);
}

function weightedMetric(items, weights, field) {
  let totalWeight = 0;
  let total = 0;
  for (let i = 0; i < items.length; i += 1) {
    const rawValue = items[i]?.[field];
    if (rawValue == null || rawValue === "") continue;
    const value = Number(rawValue);
    const weight = Number(weights[i]);
    if (!Number.isFinite(value) || !Number.isFinite(weight) || weight <= 0) continue;
    total += value * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? total / totalWeight : null;
}

function mergeEnsembleTopRows(selectedResults, sleeveWeights) {
  const byCode = new Map();
  for (let i = 0; i < selectedResults.length; i += 1) {
    const { name, result } = selectedResults[i];
    const sleeveWeight = Number(sleeveWeights[i]);
    if (!Number.isFinite(sleeveWeight) || sleeveWeight <= 0) continue;
    const topRows = result.top || [];
    const rawTotal = topRows.reduce((sum, row) => {
      const weight = Number(row.recommendedWeight);
      return sum + (Number.isFinite(weight) && weight > 0 ? weight : 0);
    }, 0);
    for (const row of topRows) {
      const rawWeight = Number(row.recommendedWeight);
      const normalizedRowWeight = rawTotal > 0 && Number.isFinite(rawWeight) && rawWeight > 0
        ? rawWeight / rawTotal
        : 1 / Math.max(1, topRows.length);
      const contribution = sleeveWeight * normalizedRowWeight;
      const existing = byCode.get(row.code);
      if (existing) {
        existing.recommendedWeight += contribution;
        existing.recommendedWeightPct = existing.recommendedWeight * 100;
        existing.strategySources = `${existing.strategySources}|${name}`;
      } else {
        byCode.set(row.code, {
          ...row,
          recommendedWeight: contribution,
          recommendedWeightPct: contribution * 100,
          strategySources: name,
        });
      }
    }
  }
  return Array.from(byCode.values()).sort((a, b) => b.recommendedWeight - a.recommendedWeight);
}

function walkForwardEnsembleOptimize(periodResultsByParam, options = {}) {
  const minTrainPeriods = options.minTrainPeriods ?? 3;
  const topK = Math.max(1, Math.floor(options.topK ?? 5));
  const names = Array.from(periodResultsByParam.keys());
  if (!names.length) return [];
  const periodCount = Math.min(...names.map((name) => periodResultsByParam.get(name).length));
  const selections = [];
  let incumbentName = options.stableParamName || null;
  for (let index = minTrainPeriods; index < periodCount; index += 1) {
    const rawTrainingRows = walkForwardTrainingRows(periodResultsByParam, names, index, options);
    const { rows: trainingRows, filteredParamCount } = eligibleWalkForwardTrainingRows(rawTrainingRows, index, options);
    if (options.knownOutcomeOnly) {
      const bestKnownTrainingPeriods = Math.max(...trainingRows.map((row) => row.trainingPeriods || 0), 0);
      if (bestKnownTrainingPeriods < minTrainPeriods) continue;
    }
    const decision = topK === 1
      ? selectWalkForwardTrainingRow(
        trainingRows,
        walkForwardIncumbentName(incumbentName, options),
        options
      )
      : null;
    const selectedRows = decision?.selected
      ? [decision.selected]
      : trainingRows.slice(0, Math.min(topK, trainingRows.length));
    if (!selectedRows.length) continue;
    incumbentName = options.incumbentPolicy === "stable" && options.stableParamName
      ? options.stableParamName
      : selectedRows[0].name;
    const sleeveWeights = normalizeEnsembleWeights(selectedRows, options);
    const selectedResults = selectedRows.map((row) => ({
      ...row,
      result: periodResultsByParam.get(row.name)[index],
    }));
    const result = selectedResults[0].result;
    const top = mergeEnsembleTopRows(selectedResults, sleeveWeights);
    const weightedTopReturn = weightedReturn(top);
    const netWeightedTopReturn = weightedReturn(top, "netForwardReturn");
    const weightedBenchmarkReturn = weightedReturn(top, "benchmarkForwardReturn");
    const netWeightedBenchmarkReturn = weightedReturn(top, "netBenchmarkForwardReturn");
    const topReturns = top.map((row) => row.forwardReturn).filter(Number.isFinite);
    const netTopReturns = top.map((row) => row.netForwardReturn).filter(Number.isFinite);
    const topBenchmarkReturns = top.map((row) => row.benchmarkForwardReturn).filter(Number.isFinite);
    const netTopBenchmarkReturns = top.map((row) => row.netBenchmarkForwardReturn).filter(Number.isFinite);
    selections.push({
      periodIndex: index,
      period: `${result.asOf}:${result.end}`,
      asOf: result.asOf,
      end: result.end,
      selectedParam: selectedRows.map((row) => row.name).join("+"),
      selectedParams: selectedRows.map((row) => row.name),
      candidateParam: decision?.candidate?.name ?? null,
      incumbentParam: decision?.incumbent?.name ?? null,
      selectionReason: decision?.selectionReason ?? "topk_score",
      candidateTrainingScore: decision?.candidate?.trainingScore ?? null,
      candidateScoreAdvantage: decision?.candidateScoreAdvantage ?? null,
      eligibleParamCount: trainingRows.length,
      filteredParamCount,
      ensembleTopK: selectedRows.length,
      ensembleWeighting: options.weighting || "equal",
      trainingScore: weightedMetric(selectedRows, sleeveWeights, "trainingScore"),
      trainingAvgReturn: weightedMetric(selectedRows, sleeveWeights, "trainingAvgReturn"),
      trainingAvgExcess: weightedMetric(selectedRows, sleeveWeights, "trainingAvgExcess"),
      trainingHitRate: weightedMetric(selectedRows, sleeveWeights, "trainingHitRate"),
      trainingPeriods: selectedRows[0].trainingPeriods,
      trainingReturnVol: weightedMetric(selectedRows, sleeveWeights, "trainingReturnVol"),
      trainingExcessVol: weightedMetric(selectedRows, sleeveWeights, "trainingExcessVol"),
      trainingReturnDownside: weightedMetric(selectedRows, sleeveWeights, "trainingReturnDownside"),
      trainingExcessDownside: weightedMetric(selectedRows, sleeveWeights, "trainingExcessDownside"),
      trainingWorstReturn: weightedMetric(selectedRows, sleeveWeights, "trainingWorstReturn"),
      trainingWorstExcess: weightedMetric(selectedRows, sleeveWeights, "trainingWorstExcess"),
      adaptiveWeightedTopReturn: weightedMetric(selectedResults.map((row) => row.result), sleeveWeights, "adaptiveWeightedTopReturn"),
      netAdaptiveWeightedTopReturn: weightedMetric(selectedResults.map((row) => row.result), sleeveWeights, "netAdaptiveWeightedTopReturn"),
      weightedTopReturn,
      netWeightedTopReturn,
      topMeanReturn: mean(topReturns),
      netTopMeanReturn: mean(netTopReturns),
      universeMeanReturn: weightedMetric(selectedResults.map((row) => row.result), sleeveWeights, "universeMeanReturn"),
      netUniverseMeanReturn: weightedMetric(selectedResults.map((row) => row.result), sleeveWeights, "netUniverseMeanReturn"),
      weightedBenchmarkReturn,
      netWeightedBenchmarkReturn,
      benchmarkOverlayWeight: weightedMetric(selectedResults.map((row) => row.result), sleeveWeights, "benchmarkOverlayWeight"),
      defensiveCashWeight: weightedMetric(selectedResults.map((row) => row.result), sleeveWeights, "defensiveCashWeight"),
      weakMarketCashWeight: weightedMetric(selectedResults.map((row) => row.result), sleeveWeights, "weakMarketCashWeight"),
      exhaustionCashWeight: weightedMetric(selectedResults.map((row) => row.result), sleeveWeights, "exhaustionCashWeight"),
      adaptiveExcessVsBenchmark: weightedMetric(selectedResults.map((row) => row.result), sleeveWeights, "adaptiveExcessVsBenchmark"),
      netAdaptiveExcessVsBenchmark: weightedMetric(selectedResults.map((row) => row.result), sleeveWeights, "netAdaptiveExcessVsBenchmark"),
      weightedExcessVsBenchmark: Number.isFinite(weightedTopReturn) && Number.isFinite(weightedBenchmarkReturn)
        ? weightedTopReturn - weightedBenchmarkReturn
        : null,
      netWeightedExcessVsBenchmark: Number.isFinite(netWeightedTopReturn) && Number.isFinite(netWeightedBenchmarkReturn)
        ? netWeightedTopReturn - netWeightedBenchmarkReturn
        : null,
      adaptiveWeightedExcessReturn: weightedMetric(selectedResults.map((row) => row.result), sleeveWeights, "adaptiveWeightedExcessReturn"),
      netAdaptiveWeightedExcessReturn: weightedMetric(selectedResults.map((row) => row.result), sleeveWeights, "netAdaptiveWeightedExcessReturn"),
      topExcessVsBenchmark: Number.isFinite(mean(topReturns)) && Number.isFinite(mean(topBenchmarkReturns))
        ? mean(topReturns) - mean(topBenchmarkReturns)
        : null,
      netTopExcessVsBenchmark: Number.isFinite(mean(netTopReturns)) && Number.isFinite(mean(netTopBenchmarkReturns))
        ? mean(netTopReturns) - mean(netTopBenchmarkReturns)
        : null,
      pValue: null,
      scoredCount: Math.round(weightedMetric(selectedResults.map((row) => row.result), sleeveWeights, "scoredCount") ?? 0),
      skippedCount: Math.round(weightedMetric(selectedResults.map((row) => row.result), sleeveWeights, "skippedCount") ?? 0),
      top,
    });
  }
  return selections;
}

module.exports = {
  adaptivePortfolioStats,
  applyCrossSectionalRankScore,
  applyBenchmarkRelativeMetrics,
  applyDynamicGroupMetrics,
  applyIndustryMomentumMetrics,
  assignRecommendedWeights,
  auditUniverseFields,
  avgTurnover,
  benchmarkReturn,
  benchmarkOverlayWeight,
  clamp,
  defaultParams,
  entryTradability,
  evaluatePeriod,
  exitTradability,
  exhaustionCashWeight,
  futureReturn,
  futureReturnDetails,
  marketSymbol,
  mean,
  optimizeParams,
  paramGrid,
  parseCsv,
  scoreAtDate,
  sliceKline,
  stddev,
  variance,
  weightedReturn,
  welchTTest,
  walkForwardEnsembleOptimize,
  walkForwardOptimize,
  walkForwardPoolSelect,
  writeCsv,
  universeEligibility,
};
