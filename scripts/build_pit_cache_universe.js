#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const { writeCsv } = require("./lib/backtest_engine");
const { defaultCacheDir } = require("./lib/paths");

const TENCENT_VOLUME_UNIT_POLICY = "tencent_market_specific_volume_units_v2";
const DEFAULT_CACHE_DIR = defaultCacheDir();
const DEFAULT_LOOKBACK = 520;
const DEFAULT_MIN_HISTORY = 65;
const DEFAULT_MAX_STALE_CALENDAR_DAYS = 14;

const OUTPUT_HEADERS = [
  "theme",
  "code",
  "name",
  "market",
  "industry",
  "physical_layers",
  "concepts",
  "concept_codes",
  "layer_count",
  "concept_count",
  "relevance",
  "reason",
  "price",
  "pct_chg",
  "amount",
  "pe",
  "pb",
  "total_mv",
  "source",
  "asOf",
  "lastTradeDate",
  "historyDays",
  "avgTurnover20",
  "lookback",
];

function usage() {
  return [
    "Usage: node build_pit_cache_universe.js --as-of <YYYY-MM-DD> --out-dir <dir> [options]",
    "",
    "Options:",
    "  --cache-dir <dir>                  Kline cache root, default $ALPHA_DATA_HOME/cache/kline or ~/.codex/alpha/cache/kline",
    "  --as-of <YYYY-MM-DD>               Build one point-in-time universe; can be repeated",
    "  --as-of-dates <date1,date2>         Comma-separated point-in-time dates",
    "  --out-dir <dir>                    Output directory",
    "  --lookback <n>                     Tencent cache lookback suffix, default 520",
    "  --min-history <n>                  Minimum valid pre-asOf rows, default 65",
    "  --max-stale-calendar-days <n>       Latest valid pre-asOf trade must be within n calendar days, default 14",
    "  --min-avg-turnover <n>              Minimum last-20 average turnover before asOf, default 0",
    "  --help",
  ].join("\n");
}

function parseNumberOption(value, option, { integer = false, min = null } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || (min != null && n < min)) {
    throw new Error(`Invalid value for ${option}: ${value}`);
  }
  return n;
}

function parseDate(value, option = "date") {
  const s = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`Invalid ${option}: ${value}`);
  const date = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== s) {
    throw new Error(`Invalid ${option}: ${value}`);
  }
  return s;
}

function pushAsOfDates(args, value) {
  for (const part of String(value || "").split(",")) {
    const date = part.trim();
    if (date) args.asOfDates.push(parseDate(date, "--as-of-dates"));
  }
}

function parseArgs(argv) {
  const args = {
    cacheDir: DEFAULT_CACHE_DIR,
    asOfDates: [],
    outDir: "",
    lookback: DEFAULT_LOOKBACK,
    minHistory: DEFAULT_MIN_HISTORY,
    maxStaleCalendarDays: DEFAULT_MAX_STALE_CALENDAR_DAYS,
    minAvgTurnover: 0,
    help: false,
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
    } else if (arg === "--cache-dir") {
      args.cacheDir = path.resolve(next());
    } else if (arg === "--as-of") {
      args.asOfDates.push(parseDate(next(), "--as-of"));
    } else if (arg === "--as-of-dates") {
      pushAsOfDates(args, next());
    } else if (arg === "--out-dir") {
      args.outDir = path.resolve(next());
    } else if (arg === "--lookback") {
      args.lookback = parseNumberOption(next(), arg, { integer: true, min: 1 });
    } else if (arg === "--min-history") {
      args.minHistory = parseNumberOption(next(), arg, { integer: true, min: 1 });
    } else if (arg === "--max-stale-calendar-days") {
      args.maxStaleCalendarDays = parseNumberOption(next(), arg, { integer: true, min: 0 });
    } else if (arg === "--min-avg-turnover") {
      args.minAvgTurnover = parseNumberOption(next(), arg, { min: 0 });
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  args.asOfDates = Array.from(new Set(args.asOfDates));
  if (!args.help && !args.asOfDates.length) throw new Error("Missing --as-of or --as-of-dates");
  if (!args.help && !args.outDir) throw new Error("Missing --out-dir");
  return args;
}

function cacheFilenameMeta(file) {
  const base = path.basename(file);
  const match = /^(sh|sz|bj|hk)([A-Za-z0-9]+)_([0-9]+)_qfq\.json$/.exec(base);
  if (!match) return null;
  const [, prefix, code, lookbackText] = match;
  return {
    symbol: `${prefix}${code}`,
    prefix,
    code,
    lookback: Number(lookbackText),
  };
}

function marketForPrefix(prefix) {
  if (prefix === "sh") return "沪市";
  if (prefix === "sz") return "深市";
  if (prefix === "bj") return "北交所/新三板系";
  if (prefix === "hk") return "港股通";
  return "";
}

function normalizeCachedKlinePayload(payload) {
  if (!(payload && payload.source === "tencent") || !Array.isArray(payload.kline)) return payload;
  if (payload.volumeUnitPolicy === TENCENT_VOLUME_UNIT_POLICY) return payload;
  const symbol = String(payload.symbol || "");
  if (!symbol.startsWith("sh")) return payload;
  return {
    ...payload,
    volumeUnitPolicy: TENCENT_VOLUME_UNIT_POLICY,
    legacyVolumeAdjusted: true,
    kline: payload.kline.map((row) => ({
      ...row,
      volume: Number.isFinite(Number(row.volume)) ? Number(row.volume) / 100 : row.volume,
    })),
  };
}

function readJsonPayload(file) {
  return normalizeCachedKlinePayload(JSON.parse(fs.readFileSync(file, "utf8")));
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return "";
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function turnoverForRow(row) {
  const amount = num(row.amount);
  if (amount != null && amount > 0) return amount;
  const close = num(row.close);
  const volume = num(row.volume);
  if (close != null && close > 0 && volume != null && volume > 0) return close * volume;
  return null;
}

function validTradingRowsOnOrBefore(kline, asOf) {
  return kline
    .filter((row) => row && typeof row.date === "string" && row.date <= asOf)
    .map((row) => {
      const close = num(row.close);
      const turnover = turnoverForRow(row);
      return { ...row, close, turnover };
    })
    .filter((row) => row.date && row.close != null && row.close > 0 && row.turnover != null && row.turnover > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function mean(values) {
  const xs = values.filter((value) => Number.isFinite(value));
  return xs.length ? xs.reduce((sum, value) => sum + value, 0) / xs.length : null;
}

function calendarDayDiff(fromDate, toDate) {
  const from = new Date(`${fromDate}T00:00:00Z`).getTime();
  const to = new Date(`${toDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return Infinity;
  return Math.floor((to - from) / 86400000);
}

function pctChange(last, prev) {
  if (!prev || !Number.isFinite(prev.close) || prev.close <= 0) return "";
  return round(((last.close / prev.close) - 1) * 100, 4);
}

function symbolToUniverseRow({ meta, payload, asOf, minHistory, maxStaleCalendarDays, minAvgTurnover }) {
  const kline = Array.isArray(payload?.kline) ? payload.kline : [];
  if (!kline.length) return { skipReason: "empty_kline" };

  const history = validTradingRowsOnOrBefore(kline, asOf);
  if (history.length < minHistory) return { skipReason: "insufficient_history_before_asof" };

  const last = history.at(-1);
  const staleDays = calendarDayDiff(last.date, asOf);
  if (staleDays > maxStaleCalendarDays) return { skipReason: "stale_before_asof" };

  const turnoverSlice = history.slice(-20).map((row) => row.turnover);
  const avgTurnover20 = mean(turnoverSlice);
  if (avgTurnover20 == null || avgTurnover20 < minAvgTurnover) return { skipReason: "low_turnover" };

  const prev = history.length >= 2 ? history.at(-2) : null;
  return {
    row: {
      theme: "pit_cache_technical",
      code: meta.code,
      name: payload?.name || payload?.symbol || meta.symbol,
      market: marketForPrefix(meta.prefix),
      industry: "",
      physical_layers: "",
      concepts: "",
      concept_codes: "",
      layer_count: "",
      concept_count: "",
      relevance: `pit_cache_${asOf}`,
      reason: `generated_from_local_kline_cache_asof_${asOf}_no_future_membership`,
      price: round(last.close, 4),
      pct_chg: pctChange(last, prev),
      amount: round(last.turnover, 2),
      pe: "",
      pb: "",
      total_mv: "",
      source: `local_kline_cache_${meta.lookback}_qfq|pit_asof_${asOf}`,
      asOf,
      lastTradeDate: last.date,
      historyDays: history.length,
      avgTurnover20: round(avgTurnover20, 2),
      lookback: meta.lookback,
    },
  };
}

function recordSkip(summary, reason) {
  summary.skippedByReason[reason] = (summary.skippedByReason[reason] || 0) + 1;
}

function countMarkets(rows) {
  const counts = {};
  for (const row of rows) {
    const market = row.market || "UNKNOWN";
    counts[market] = (counts[market] || 0) + 1;
  }
  return counts;
}

function buildPitUniverseForDate(options) {
  const asOf = parseDate(options.asOf, "asOf");
  const cacheDir = path.resolve(options.cacheDir || DEFAULT_CACHE_DIR);
  const lookback = options.lookback ?? DEFAULT_LOOKBACK;
  const minHistory = options.minHistory ?? DEFAULT_MIN_HISTORY;
  const maxStaleCalendarDays = options.maxStaleCalendarDays ?? DEFAULT_MAX_STALE_CALENDAR_DAYS;
  const minAvgTurnover = options.minAvgTurnover ?? 0;
  const tencentDir = path.join(cacheDir, "tencent");
  const files = fs.existsSync(tencentDir)
    ? fs.readdirSync(tencentDir).filter((file) => file.endsWith(".json")).sort()
    : [];
  const summary = {
    asOf,
    cacheDir,
    lookback,
    minHistory,
    maxStaleCalendarDays,
    minAvgTurnover,
    totalFiles: files.length,
    consideredFiles: 0,
    rowCount: 0,
    marketCounts: {},
    skippedByReason: {},
  };
  const rows = [];

  for (const file of files) {
    const meta = cacheFilenameMeta(file);
    if (!meta) {
      recordSkip(summary, "bad_filename");
      continue;
    }
    if (meta.lookback !== lookback) {
      recordSkip(summary, "lookback_mismatch");
      continue;
    }
    summary.consideredFiles += 1;

    let payload;
    try {
      payload = readJsonPayload(path.join(tencentDir, file));
    } catch {
      recordSkip(summary, "invalid_json");
      continue;
    }

    const result = symbolToUniverseRow({
      meta,
      payload,
      asOf,
      minHistory,
      maxStaleCalendarDays,
      minAvgTurnover,
    });
    if (result.skipReason) {
      recordSkip(summary, result.skipReason);
      continue;
    }
    rows.push(result.row);
  }

  rows.sort((a, b) => {
    const symbolA = `${marketSortKey(a.market)}:${a.code}`;
    const symbolB = `${marketSortKey(b.market)}:${b.code}`;
    return symbolA.localeCompare(symbolB);
  });
  summary.rowCount = rows.length;
  summary.marketCounts = countMarkets(rows);
  return { asOf, rows, summary };
}

function marketSortKey(market) {
  if (market === "沪市") return "1";
  if (market === "深市") return "2";
  if (market === "北交所/新三板系") return "3";
  if (market === "港股通") return "4";
  return "9";
}

function run(args) {
  fs.mkdirSync(args.outDir, { recursive: true });
  const asOfResults = [];
  const universes = {};
  for (const asOf of args.asOfDates) {
    const result = buildPitUniverseForDate({ ...args, asOf });
    const file = `pit_universe_${asOf}.csv`;
    writeCsv(path.join(args.outDir, file), result.rows, OUTPUT_HEADERS);
    universes[asOf] = result;
    asOfResults.push({
      asOf,
      file,
      rowCount: result.rows.length,
      marketCounts: result.summary.marketCounts,
      summary: result.summary,
    });
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    cacheDir: args.cacheDir,
    outDir: args.outDir,
    lookback: args.lookback,
    minHistory: args.minHistory,
    maxStaleCalendarDays: args.maxStaleCalendarDays,
    minAvgTurnover: args.minAvgTurnover,
    pointInTimePolicy: "membership_uses_only_local_kline_rows_on_or_before_asOf",
    caveat: "This is a local-cache point-in-time approximation. It reduces future membership leakage by requiring valid pre-asOf trading history, but it does not reconstruct delisted stocks or historical concept/industry membership.",
    asOfResults,
  };
  fs.writeFileSync(path.join(args.outDir, "pit_universe_manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { outDir: args.outDir, manifest, universes };
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      return;
    }
    const result = run(args);
    console.log(`Wrote ${result.manifest.asOfResults.length} PIT universes to ${result.outDir}`);
    for (const item of result.manifest.asOfResults) {
      console.log(`${item.asOf}: ${item.rowCount} rows -> ${item.file}`);
    }
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
  OUTPUT_HEADERS,
  buildPitUniverseForDate,
  cacheFilenameMeta,
  marketForPrefix,
  parseArgs,
  run,
  symbolToUniverseRow,
};
