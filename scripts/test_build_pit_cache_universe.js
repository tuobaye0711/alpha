const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { parseCsv } = require("./lib/backtest_engine");
const {
  buildPitUniverseForDate,
  parseArgs,
  run,
} = require("./build_pit_cache_universe");

function writePayload(cacheDir, symbol, rows, lookback = 520) {
  const dir = path.join(cacheDir, "tencent");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${symbol}_${lookback}_qfq.json`),
    `${JSON.stringify(
      {
        source: "tencent",
        symbol,
        fetchedAt: "2026-06-06T00:00:00.000Z",
        kline: rows,
      },
      null,
      2
    )}\n`
  );
}

function row(date, close, volume = 10000, extra = {}) {
  return {
    date,
    open: close,
    close,
    high: close,
    low: close,
    volume,
    ...extra,
  };
}

test("PIT cache universe includes only tradable rows known by asOf", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-pit-cache-"));
  const cacheDir = path.join(tmp, "cache");

  writePayload(cacheDir, "sh600001", [
    row("2026-03-27", 10.5, 1000),
    row("2026-03-30", 10.8, 1100),
    row("2026-03-31", 11.0, 1200),
    row("2026-04-01", 11.2, 1300),
    row("2026-04-02", 12.5, 5000000),
  ]);
  writePayload(cacheDir, "sz300001", [
    row("2026-03-27", 20.5, 2000),
    row("2026-03-30", 20.8, 2100),
    row("2026-03-31", 21.0, 2200),
    row("2026-04-01", 21.2, 2300),
  ]);
  writePayload(cacheDir, "bj920002", [row("2026-06-05", 8.8, 900)]);
  writePayload(cacheDir, "hk00926", [
    row("2026-02-02", 3.1, 9000),
    row("2026-02-03", 3.2, 9000),
    row("2026-02-04", 3.3, 9000),
  ]);
  writePayload(cacheDir, "sz300002", [
    row("2026-03-27", 0, 1000),
    row("2026-03-30", 10, 0),
    row("2026-04-01", 10, 0),
  ]);

  const result = buildPitUniverseForDate({
    cacheDir,
    asOf: "2026-04-01",
    lookback: 520,
    minHistory: 3,
    maxStaleCalendarDays: 7,
    minAvgTurnover: 0,
  });

  assert.deepEqual(
    result.rows.map((item) => item.code),
    ["600001", "300001"]
  );
  assert.deepEqual(
    result.rows.map((item) => item.market),
    ["沪市", "深市"]
  );
  assert.equal(result.rows[0].theme, "pit_cache_technical");
  assert.equal(result.rows[0].name, "sh600001");
  assert.equal(result.rows[0].price, 11.2);
  assert.equal(result.rows[0].lastTradeDate, "2026-04-01");
  assert.equal(result.rows[0].historyDays, 4);
  assert.equal(result.rows[0].relevance, "pit_cache_2026-04-01");
  assert.equal(result.rows[0].reason, "generated_from_local_kline_cache_asof_2026-04-01_no_future_membership");
  assert.equal(result.rows[0].source, "local_kline_cache_520_qfq|pit_asof_2026-04-01");
  assert.equal(result.summary.totalFiles, 5);
  assert.equal(result.summary.skippedByReason.insufficient_history_before_asof, 2);
  assert.equal(result.summary.skippedByReason.stale_before_asof, 1);
});

test("PIT cache universe runner writes per-asOf CSV outputs and manifest", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-pit-cache-run-"));
  const cacheDir = path.join(tmp, "cache");
  const outDir = path.join(tmp, "out");

  writePayload(cacheDir, "hk01810", [
    row("2026-03-27", 16.5, 1000),
    row("2026-03-30", 16.8, 1100),
    row("2026-03-31", 17.0, 1200),
    row("2026-04-01", 17.2, 1300),
  ]);

  const result = run(
    parseArgs([
      "--cache-dir",
      cacheDir,
      "--as-of-dates",
      "2026-04-01,2026-05-04",
      "--out-dir",
      outDir,
      "--lookback",
      "520",
      "--min-history",
      "3",
      "--max-stale-calendar-days",
      "20",
    ])
  );

  assert.equal(result.manifest.asOfResults.length, 2);
  assert.equal(result.manifest.asOfResults[0].rowCount, 1);
  assert.equal(result.manifest.pointInTimePolicy, "membership_uses_only_local_kline_rows_on_or_before_asOf");
  assert.ok(fs.existsSync(path.join(outDir, "pit_universe_2026-04-01.csv")));
  assert.ok(fs.existsSync(path.join(outDir, "pit_universe_2026-05-04.csv")));
  assert.ok(fs.existsSync(path.join(outDir, "pit_universe_manifest.json")));

  const rows = parseCsv(fs.readFileSync(path.join(outDir, "pit_universe_2026-04-01.csv"), "utf8"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, "01810");
  assert.equal(rows[0].market, "港股通");
  assert.equal(rows[0].source, "local_kline_cache_520_qfq|pit_asof_2026-04-01");

  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "pit_universe_manifest.json"), "utf8"));
  assert.equal(manifest.asOfResults[0].file, "pit_universe_2026-04-01.csv");
  assert.equal(manifest.asOfResults[1].summary.skippedByReason.stale_before_asof, 1);
});
