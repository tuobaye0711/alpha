#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const { writeCsv, parseCsv } = require("./lib/backtest_engine");
const { defaultCacheDir, defaultOutputRoot } = require("./lib/paths");
const { backfillTencentKlineCache } = require("./backfill_tencent_kline_cache");
const currentReport = require("./build_current_alpha_selection_report");

const DEFAULT_OUTPUT_ROOT = defaultOutputRoot();
const DEFAULT_CACHE_DIR = defaultCacheDir();
const DEFAULT_HK_CONNECT = path.join(DEFAULT_OUTPUT_ROOT, "cache-wide-universe-variants-v1-20260607", "cache_wide_hk_connect.csv");
const DEFAULT_PARAM = "rank_tradable_acceleration_balanced_v22_top15";
const DEFAULT_BATCH_SIZE = 80;

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function usage() {
  return [
    "Usage: node build_current_full_alpha_report.js [options]",
    "",
    "Options:",
    "  --out-root <dir>       Output root, default ~/.codex/alpha/output/current-full-alpha-<timestamp>",
    "  --cache-dir <dir>      K-line cache root",
    "  --concurrency <n>      K-line fetch concurrency, default 32",
    "  --quote-concurrency <n> Quote discovery concurrency, default 10",
    "  --hk-connect <csv>     Existing HK Stock Connect universe CSV",
    "  --no-fetch             Do not fetch missing 900-day K-line cache",
    "  --a-only               Exclude HK Stock Connect rows",
    "  --help",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    outRoot: path.join(DEFAULT_OUTPUT_ROOT, `current-full-alpha-${timestamp()}`),
    cacheDir: DEFAULT_CACHE_DIR,
    concurrency: 32,
    quoteConcurrency: 10,
    hkConnect: DEFAULT_HK_CONNECT,
    fetchMissing: true,
    includeHk: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return argv[i];
    };
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--out-root") args.outRoot = path.resolve(next());
    else if (arg === "--cache-dir") args.cacheDir = path.resolve(next());
    else if (arg === "--concurrency") args.concurrency = Number(next());
    else if (arg === "--quote-concurrency") args.quoteConcurrency = Number(next());
    else if (arg === "--hk-connect") args.hkConnect = path.resolve(next());
    else if (arg === "--no-fetch") args.fetchMissing = false;
    else if (arg === "--a-only") args.includeHk = false;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency <= 0) throw new Error("Invalid --concurrency");
  if (!Number.isInteger(args.quoteConcurrency) || args.quoteConcurrency <= 0) throw new Error("Invalid --quote-concurrency");
  return args;
}

function range(prefix, start, end) {
  const out = [];
  for (let n = start; n <= end; n += 1) {
    out.push(`${prefix}${String(n).padStart(6, "0")}`);
  }
  return out;
}

function candidateAShareSymbols() {
  return [
    ...range("sz", 1, 3999),
    ...range("sz", 300000, 301999),
    ...range("sh", 600000, 605999),
    ...range("sh", 688000, 689999),
    ...range("bj", 430000, 439999),
    ...range("bj", 830000, 839999),
    ...range("bj", 870000, 873999),
    ...range("bj", 920000, 920999),
  ];
}

function marketForSymbol(symbol) {
  const prefix = symbol.slice(0, 2);
  const code = symbol.slice(2);
  if (prefix === "hk") return "港股通";
  if (prefix === "bj") return "北交所";
  if (prefix === "sz" && /^(300|301)/.test(code)) return "创业板";
  if (prefix === "sz") return "深市";
  if (prefix === "sh" && /^(688|689)/.test(code)) return "科创板";
  if (prefix === "sh") return "沪市";
  return "";
}

function canonicalCodeFromSymbol(symbol) {
  return symbol.slice(2);
}

async function requestQuoteText(symbols) {
  const url = `https://qt.gtimg.cn/q=${symbols.join(",")}`;
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 AlphaFullUniverse/1.0" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    return new TextDecoder("gb18030").decode(buffer);
  } catch (fetchError) {
    try {
      const raw = execFileSync(
        "curl",
        ["-L", "--connect-timeout", "8", "--max-time", "18", "-sS", "-A", "Mozilla/5.0 AlphaFullUniverse/1.0", url],
        { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 }
      );
      return new TextDecoder("gb18030").decode(raw);
    } catch (curlError) {
      throw new Error(`quote fetch failed: ${fetchError.message}; curl failed: ${curlError.message}`);
    }
  }
}

function parseTencentQuotes(text) {
  const rows = [];
  const re = /v_((?:sh|sz|bj|hk)[A-Za-z0-9]+)="([^"]*)";/g;
  let match;
  while ((match = re.exec(text))) {
    const symbol = match[1];
    const fields = match[2].split("~");
    const name = String(fields[1] || "").trim();
    const code = String(fields[2] || canonicalCodeFromSymbol(symbol)).trim();
    const price = Number(fields[3]);
    const quoteTime = String(fields[30] || "").trim();
    const volume = Number(fields[36]);
    const amount = Number(fields[37]);
    if (!name || !code || !Number.isFinite(price)) continue;
    if (/(?:\*ST|ST|ＳＴ)/i.test(name)) continue;
    if (!Number.isFinite(volume) || volume <= 0) continue;
    if (!Number.isFinite(amount) || amount <= 0) continue;
    if (/090000$/.test(quoteTime)) continue;
    if (/^(?:0|-|--)$/.test(name)) continue;
    rows.push({
      symbol,
      code,
      name,
      market: marketForSymbol(symbol),
      price,
      pct_chg: fields[32] || "",
      amount,
      total_mv: fields[45] || "",
      quoteTime,
    });
  }
  return rows;
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

function chunks(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function discoverQuotedRows(symbols, quoteConcurrency) {
  const batches = chunks(symbols, DEFAULT_BATCH_SIZE);
  const results = [];
  const failures = [];
  await mapLimit(batches, quoteConcurrency, async (batch, index) => {
    try {
      const text = await requestQuoteText(batch);
      results.push(...parseTencentQuotes(text));
    } catch (error) {
      failures.push({ index, firstSymbol: batch[0], lastSymbol: batch.at(-1), error: error.message || String(error) });
    }
  });
  const bySymbol = new Map();
  for (const row of results) bySymbol.set(row.symbol, row);
  return { rows: Array.from(bySymbol.values()).sort((a, b) => a.symbol.localeCompare(b.symbol)), failures };
}

function readHkConnectSymbols(file) {
  if (!file || !fs.existsSync(file)) return [];
  return parseCsv(fs.readFileSync(file, "utf8"))
    .map((row) => String(row.code || "").replace(/\D/g, ""))
    .filter(Boolean)
    .map((code) => `hk${code.padStart(5, "0")}`);
}

function universeCsvRows(rows, theme) {
  return rows.map((row) => ({
    theme,
    code: row.code,
    name: row.name,
    market: row.market,
    industry: "",
    physical_layers: "",
    concepts: "",
    concept_codes: "",
    layer_count: 0,
    concept_count: 0,
    relevance: "full_current_quote_validated",
    reason: `generated_from_tencent_quote;quote_time:${row.quoteTime || ""}`,
    price: row.price,
    pct_chg: row.pct_chg,
    amount: row.amount,
    pe: "",
    pb: "",
    total_mv: row.total_mv,
    source: "tencent_quote_full_current",
  }));
}

function iterationSummaryRows() {
  return [
    {
      version: "v0",
      scope: "初始 current-snapshot 主题/物理AI池",
      attempt: "用当前构建的主题池和 physical-AI 池做评分、Top10 和 HTML 回测；快速验证能否产生超额。",
      result: "短样本收益高，但依赖当前概念/主题快照，存在未来成员和幸存者偏差。",
      lift: "作为探索基线，不作为 strict 生产证据。",
      status: "降级为诊断线",
    },
    {
      version: "v1",
      scope: "PIT cache universe",
      attempt: "按 asOf 从本地 K 线缓存生成近似 point-in-time 股票池，降低未来成员泄漏。",
      result: "17 窗口 PIT 全池约 8.84%/6.44%/4.66%，明显低于 current-snapshot 强结果。",
      lift: "揭示原始结果偏乐观；收益下降但可信度提升。",
      status: "成为严格基线",
    },
    {
      version: "v2",
      scope: "PIT 市场分层 + 动态 TopN",
      attempt: "把 PIT 池拆成深市、沪市、港股通等，并让 TopN=8/10/12/15 进入 walk-forward 选择。",
      result: "520 日短样本中 PIT 深市 TopN 达 15.15%/12.08%/11.19%，但 900 日长样本回落。",
      lift: "发现深市技术池更优，但短样本行情依赖较强。",
      status: "保留为研究线",
    },
    {
      version: "v3",
      scope: "三池 selector + 当前风险门禁",
      attempt: "在 pitFull/pitSz/pitSh 间按已完成历史窗口选池，并用当前 TopN 特征拦截弱趋势/拥挤切换。",
      result: "900 日长样本 m2/l5/w0：21 期 10.79%/7.12%/3.46%，相对 pitSz +2.72pct，p≈0.043。",
      lift: "相对 fixed pitSz 有显著改善，但 2025-08 沪市误切少赚 -9.07pct。",
      status: "被 v5 替代",
    },
    {
      version: "v4",
      scope: "九池板块确认门禁",
      attempt: "引入创业板/科创板/主板等板块池，要求 fresh、量能、低 lottery、相对强等同时确认。",
      result: "13 个短窗口可到 18.06%/11.03%/13.08%，但 p≈0.121，且仍未通过长样本 strict 证据。",
      lift: "适合板块研究，不作为当前 strict 三池默认。",
      status: "保留为分支候选",
    },
    {
      version: "v5",
      scope: "900 日 strict PIT 三池最新候选",
      attempt: "继承 v1-v3，额外拦截相对60日趋势弱、fresh无补偿、lottery风险未降低且缺少绝对/基准确认的切换。",
      result: "21 期 11.23%/7.55%/4.05%，相对 pitSz +3.15pct，p≈0.0098；trained-only 相对 pitSz +3.67pct，p≈0.0081。",
      lift: "相对 v1 900日全池 +4.99pct 净收益；相对 v3 +0.44pct；最差相对差值从 -9.07pct 收窄到 -1.03pct。",
      status: "当前 strict PIT 技术线最强显式候选",
    },
  ];
}

function mergeUniverseRows(aRows, hkRows) {
  const byKey = new Map();
  for (const row of [...aRows, ...hkRows]) {
    const key = `${row.market === "港股通" ? "hk" : "cn"}:${row.code}`;
    if (!byKey.has(key)) byKey.set(key, row);
  }
  return Array.from(byKey.values());
}

async function run(args) {
  fs.mkdirSync(args.outRoot, { recursive: true });
  const aSymbols = candidateAShareSymbols();
  console.log(`[alpha-full] discover A-share candidates=${aSymbols.length}`);
  const aDiscovery = await discoverQuotedRows(aSymbols, args.quoteConcurrency);
  const aRows = universeCsvRows(aDiscovery.rows, "full_a_share_current");
  console.log(`[alpha-full] A-share valid=${aRows.length} quote_failures=${aDiscovery.failures.length}`);

  let hkRows = [];
  let hkDiscovery = { failures: [] };
  if (args.includeHk) {
    const hkSymbols = readHkConnectSymbols(args.hkConnect);
    hkDiscovery = await discoverQuotedRows(hkSymbols, args.quoteConcurrency);
    hkRows = universeCsvRows(hkDiscovery.rows, "hk_connect_current");
    console.log(`[alpha-full] HK-connect source=${hkSymbols.length} valid=${hkRows.length} quote_failures=${hkDiscovery.failures.length}`);
  }

  const universeRows = mergeUniverseRows(aRows, hkRows);
  const universeFile = path.join(args.outRoot, "current_full_universe.csv");
  const headers = [
    "theme", "code", "name", "market", "industry", "physical_layers", "concepts", "concept_codes",
    "layer_count", "concept_count", "relevance", "reason", "price", "pct_chg", "amount", "pe", "pb", "total_mv", "source",
  ];
  writeCsv(universeFile, universeRows, headers);

  const symbols = [
    ...aDiscovery.rows.map((row) => row.symbol),
    ...hkDiscovery.rows.map((row) => row.symbol),
  ];
  let backfillManifest = null;
  if (args.fetchMissing) {
    backfillManifest = await backfillTencentKlineCache({
      cacheDir: args.cacheDir,
      sourceLookback: 900,
      targetLookback: 900,
      symbols,
      limit: 0,
      concurrency: args.concurrency,
      refresh: false,
      dryRun: false,
    });
    console.log(`[alpha-full] kline total=${backfillManifest.summary.totalSymbols} fetched=${backfillManifest.summary.fetched} skipped=${backfillManifest.summary.skippedExisting} failed=${backfillManifest.summary.failed}`);
  }

  const reportDir = path.join(args.outRoot, "latest_v5_report");
  const report = currentReport.buildReport({
    universeFiles: [universeFile],
    cacheDir: args.cacheDir,
    outDir: reportDir,
    asOf: "",
    lookbacks: [900, 520, 420],
    paramName: DEFAULT_PARAM,
    topN: 15,
    selectedPool: "pitSz / relative-trend-crowding-v5",
    cashReservePct: 20,
    neutralTheme: true,
    nameSourceFiles: [universeFile],
  });
  report.title = "Alpha v5 当前全量股票池进攻候选";
  report.iterations = iterationSummaryRows();
  report.caveats.unshift(
    "本次全量池由腾讯批量行情校验 A 股主代码段生成，并合并本地港股通清单；A 股不是只用旧 1710 只缓存池。",
    args.includeHk
      ? "港股通范围来自本地 cache-wide 港股通清单并用腾讯行情校验；若港股通成分当天变化，本报告不会自动补入新增成分。"
      : "本次按 --a-only 仅覆盖 A 股。"
  );
  currentReport.writeReport(report, reportDir);

  const manifest = {
    generatedAt: new Date().toISOString(),
    outRoot: args.outRoot,
    universeFile,
    reportDir,
    html: path.join(reportDir, "current_selection_report.html"),
    source: {
      aShareDiscovery: "Tencent quote enum over mainstream A-share code ranges",
      hkConnectSource: args.includeHk ? args.hkConnect : "",
      klineCache: args.cacheDir,
    },
    discovery: {
      aCandidateSymbols: aSymbols.length,
      aValidRows: aRows.length,
      aQuoteFailures: aDiscovery.failures.length,
      hkValidRows: hkRows.length,
      hkQuoteFailures: hkDiscovery.failures.length,
    },
    backfillSummary: backfillManifest?.summary || null,
    report: {
      asOf: report.asOf,
      universeCount: report.universeCount,
      scoredCount: report.scoredCount,
      skippedCount: report.skippedCount,
      selectedParam: report.selectedParam,
      top: report.rows.map((row) => ({
        rank: row.rank,
        code: row.code,
        name: row.name,
        market: row.market,
        score: row.score,
        recommendedWeightPct: row.recommendedWeightPct,
        expectedExcess: row.expectedExcess,
      })),
    },
    quoteFailures: [...aDiscovery.failures, ...hkDiscovery.failures],
  };
  fs.writeFileSync(path.join(args.outRoot, "current_full_run_manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[alpha-full] out=${args.outRoot}`);
  console.log(`[alpha-full] asOf=${report.asOf} universe=${report.universeCount} scored=${report.scoredCount} skipped=${report.skippedCount}`);
  console.log(`[alpha-full] html=${manifest.html}`);
  console.log(`[alpha-full] top=${report.rows.map((row) => `${row.rank}.${row.code}${row.name}`).join(",")}`);
  return manifest;
}

if (require.main === module) {
  (async () => {
    try {
      const args = parseArgs(process.argv.slice(2));
      if (args.help) {
        console.log(usage());
        return;
      }
      await run(args);
    } catch (error) {
      console.error(`[alpha-full] ${error.stack || error.message}`);
      process.exit(1);
    }
  })();
}

module.exports = {
  candidateAShareSymbols,
  discoverQuotedRows,
  iterationSummaryRows,
  parseTencentQuotes,
  run,
};
