#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { defaultCacheDir } = require("./lib/paths");

const DEFAULT_CACHE_DIR = defaultCacheDir();
const TENCENT_VOLUME_UNIT_POLICY = "tencent_market_specific_volume_units_v2";

function usage() {
  return [
    "Usage: node backfill_tencent_kline_cache.js [options]",
    "",
    "Options:",
    "  --cache-dir <dir>          Kline cache root, default $ALPHA_DATA_HOME/cache/kline or ~/.codex/alpha/cache/kline",
    "  --source-lookback <n>      Discover symbols from existing *_n_qfq.json files, default 520",
    "  --target-lookback <n>      Fetch and write *_n_qfq.json files, default 900",
    "  --symbols <a,b,c>          Optional explicit Tencent symbols, e.g. sh600000,sz000001",
    "  --limit <n>                Optional maximum symbols to process",
    "  --concurrency <n>          Concurrent fetches, default 16",
    "  --refresh                  Re-fetch target files even if they already exist",
    "  --dry-run                  Only write manifest, do not fetch or write target cache",
    "  --help",
  ].join("\n");
}

function parsePositiveInteger(value, option) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid ${option}: ${value}`);
  return n;
}

function parseArgs(argv) {
  const args = {
    cacheDir: DEFAULT_CACHE_DIR,
    sourceLookback: 520,
    targetLookback: 900,
    symbols: [],
    limit: 0,
    concurrency: 16,
    refresh: false,
    dryRun: false,
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
    } else if (arg === "--source-lookback") {
      args.sourceLookback = parsePositiveInteger(next(), arg);
    } else if (arg === "--target-lookback") {
      args.targetLookback = parsePositiveInteger(next(), arg);
    } else if (arg === "--symbols") {
      args.symbols = next().split(",").map((item) => item.trim()).filter(Boolean);
    } else if (arg === "--limit") {
      args.limit = parsePositiveInteger(next(), arg);
    } else if (arg === "--concurrency") {
      args.concurrency = parsePositiveInteger(next(), arg);
    } else if (arg === "--refresh") {
      args.refresh = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (args.targetLookback === args.sourceLookback && !args.symbols.length) {
    throw new Error("--target-lookback must differ from --source-lookback unless --symbols is provided");
  }
  return args;
}

function cacheFilenameMeta(file) {
  const match = /^(sh|sz|bj|hk)([A-Za-z0-9]+)_([0-9]+)_qfq\.json$/.exec(path.basename(file));
  if (!match) return null;
  const [, prefix, code, lookbackText] = match;
  return {
    symbol: `${prefix}${code}`,
    lookback: Number(lookbackText),
  };
}

function discoverTencentSymbols({ cacheDir, sourceLookback, symbols = [] }) {
  if (symbols.length) {
    return Array.from(new Set(symbols)).sort();
  }
  const dir = path.join(cacheDir, "tencent");
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const file of fs.readdirSync(dir).sort()) {
    const meta = cacheFilenameMeta(file);
    if (meta?.lookback === sourceLookback) out.push(meta.symbol);
  }
  return Array.from(new Set(out)).sort();
}

function tencentVolumeUnit(symbol) {
  if (symbol.startsWith("sz")) return 100;
  if (symbol.startsWith("bj")) return 100;
  return 1;
}

function parseTencentPayload(json, symbol) {
  const node = json?.data?.[symbol];
  const rows = node?.qfqday || node?.day || [];
  const volumeUnit = tencentVolumeUnit(symbol);
  return rows
    .filter((row) => Array.isArray(row) && row.length >= 6)
    .map((row) => ({
      date: row[0],
      open: Number(row[1]),
      close: Number(row[2]),
      high: Number(row[3]),
      low: Number(row[4]),
      volume: Number(row[5]) * volumeUnit,
    }))
    .filter((row) => row.date && Number.isFinite(row.close));
}

async function requestText(url, timeoutMs = 16000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 AlphaKlineBackfill/1.0" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (fetchError) {
    try {
      return execFileSync(
        "curl",
        [
          "-L",
          "--connect-timeout",
          "8",
          "--max-time",
          String(Math.ceil(timeoutMs / 1000)),
          "-sS",
          "-H",
          "User-Agent: Mozilla/5.0 AlphaKlineBackfill/1.0",
          url,
        ],
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
      );
    } catch (curlError) {
      throw new Error(`fetch failed: ${fetchError.message}; curl failed: ${curlError.message}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function targetCacheFile(cacheDir, symbol, lookback) {
  return path.join(cacheDir, "tencent", `${symbol}_${lookback}_qfq.json`);
}

async function fetchTencentKline(symbol, lookback, deps = {}) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,${lookback},qfq`;
  const text = await (deps.requestText || requestText)(url);
  const json = JSON.parse(text);
  const kline = parseTencentPayload(json, symbol);
  if (!kline.length) throw new Error("empty_tencent_kline");
  return {
    source: "tencent",
    symbol,
    url,
    fetchedAt: (deps.now ? deps.now() : new Date()).toISOString(),
    volumeUnitPolicy: TENCENT_VOLUME_UNIT_POLICY,
    kline,
  };
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return out;
}

async function backfillTencentKlineCache(args, deps = {}) {
  const allSymbols = discoverTencentSymbols(args);
  const symbols = args.limit ? allSymbols.slice(0, args.limit) : allSymbols;
  const outDir = path.join(args.cacheDir, "tencent");
  fs.mkdirSync(outDir, { recursive: true });
  const results = [];

  await mapLimit(symbols, args.concurrency, async (symbol) => {
    const file = targetCacheFile(args.cacheDir, symbol, args.targetLookback);
    if (!args.refresh && fs.existsSync(file)) {
      results.push({ symbol, status: "skipped_existing", file });
      return;
    }
    if (args.dryRun) {
      results.push({ symbol, status: "dry_run", file });
      return;
    }
    try {
      const payload = await fetchTencentKline(symbol, args.targetLookback, deps);
      fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
      results.push({
        symbol,
        status: "fetched",
        file,
        rows: payload.kline.length,
        firstDate: payload.kline[0]?.date || "",
        lastDate: payload.kline.at(-1)?.date || "",
      });
    } catch (error) {
      results.push({ symbol, status: "failed", file, error: error.message || String(error) });
    }
  });

  results.sort((a, b) => a.symbol.localeCompare(b.symbol));
  const summary = {
    totalSymbols: symbols.length,
    fetched: results.filter((row) => row.status === "fetched").length,
    skippedExisting: results.filter((row) => row.status === "skipped_existing").length,
    dryRun: results.filter((row) => row.status === "dry_run").length,
    failed: results.filter((row) => row.status === "failed").length,
  };
  const manifest = {
    generatedAt: (deps.now ? deps.now() : new Date()).toISOString(),
    cacheDir: args.cacheDir,
    sourceLookback: args.sourceLookback,
    targetLookback: args.targetLookback,
    refresh: args.refresh,
    dryRun: args.dryRun,
    summary,
    results,
  };
  fs.writeFileSync(
    path.join(args.cacheDir, `kline_backfill_${args.targetLookback}_manifest.json`),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  return manifest;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      return;
    }
    const manifest = await backfillTencentKlineCache(args);
    console.log(`[kline-backfill] target=${args.targetLookback} total=${manifest.summary.totalSymbols} fetched=${manifest.summary.fetched} skipped=${manifest.summary.skippedExisting} failed=${manifest.summary.failed}`);
  } catch (error) {
    console.error(error.message || String(error));
    console.error("");
    console.error(usage());
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  TENCENT_VOLUME_UNIT_POLICY,
  backfillTencentKlineCache,
  discoverTencentSymbols,
  parseArgs,
  parseTencentPayload,
};
