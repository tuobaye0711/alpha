const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { parseCsv } = require("./lib/backtest_engine");
const {
  buildPeriodVariants,
  parseArgs,
  run,
} = require("./build_period_universe_variants");

function writePitUniverse(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const headers = ["theme", "code", "name", "market", "reason", "source", "asOf"];
  fs.writeFileSync(
    file,
    [
      headers.join(","),
      ...rows.map((row) => headers.map((header) => row[header] || "").join(",")),
    ].join("\n")
  );
}

const ROWS_0401 = [
  { theme: "pit_cache_technical", code: "000001", name: "SZ Main", market: "深市", reason: "pit", source: "pit", asOf: "2026-04-01" },
  { theme: "pit_cache_technical", code: "002001", name: "SZ SME", market: "深市", reason: "pit", source: "pit", asOf: "2026-04-01" },
  { theme: "pit_cache_technical", code: "600001", name: "SH Main", market: "沪市", reason: "pit", source: "pit", asOf: "2026-04-01" },
  { theme: "pit_cache_technical", code: "920001", name: "BJ Sample", market: "北交所/新三板系", reason: "pit", source: "pit", asOf: "2026-04-01" },
  { theme: "pit_cache_technical", code: "01810", name: "HK Sample", market: "港股通", reason: "pit", source: "pit", asOf: "2026-04-01" },
];

const ROWS_0504 = [
  { theme: "pit_cache_technical", code: "300001", name: "SZ Growth", market: "深市", reason: "pit", source: "pit", asOf: "2026-05-04" },
  { theme: "pit_cache_technical", code: "301001", name: "SZ Growth 2", market: "深市", reason: "pit", source: "pit", asOf: "2026-05-04" },
  { theme: "pit_cache_technical", code: "688001", name: "SH STAR", market: "沪市", reason: "pit", source: "pit", asOf: "2026-05-04" },
];

test("period universe variants split every asOf file and preserve PIT file names", () => {
  const result = buildPeriodVariants([
    { file: "/tmp/pit_universe_2026-04-01.csv", asOf: "2026-04-01", rows: ROWS_0401, headers: Object.keys(ROWS_0401[0]) },
    { file: "/tmp/pit_universe_2026-05-04.csv", asOf: "2026-05-04", rows: ROWS_0504, headers: Object.keys(ROWS_0504[0]) },
  ]);

  assert.deepEqual(result.variants.map((variant) => variant.name), [
    "pitCacheA",
    "pitCacheAExBj",
    "pitCacheSz",
    "pitCacheSh",
    "pitCacheHk",
    "pitCacheSzMain",
    "pitCacheChiNext",
    "pitCacheShMain",
    "pitCacheStar",
    "pitCacheBj",
  ]);
  assert.deepEqual(result.variants.find((variant) => variant.name === "pitCacheA").asOfResults.map((item) => item.rowCount), [4, 3]);
  assert.deepEqual(result.variants.find((variant) => variant.name === "pitCacheAExBj").asOfResults.map((item) => item.rowCount), [3, 3]);
  assert.deepEqual(result.variants.find((variant) => variant.name === "pitCacheSz").asOfResults.map((item) => item.rowCount), [2, 2]);
  assert.deepEqual(result.variants.find((variant) => variant.name === "pitCacheHk").asOfResults.map((item) => item.rowCount), [1, 0]);
  assert.deepEqual(result.variants.find((variant) => variant.name === "pitCacheSzMain").asOfResults.map((item) => item.rowCount), [2, 0]);
  assert.deepEqual(result.variants.find((variant) => variant.name === "pitCacheChiNext").asOfResults.map((item) => item.rowCount), [0, 2]);
  assert.deepEqual(result.variants.find((variant) => variant.name === "pitCacheShMain").asOfResults.map((item) => item.rowCount), [1, 0]);
  assert.deepEqual(result.variants.find((variant) => variant.name === "pitCacheStar").asOfResults.map((item) => item.rowCount), [0, 1]);
  assert.deepEqual(result.variants.find((variant) => variant.name === "pitCacheBj").asOfResults.map((item) => item.rowCount), [1, 0]);

  const szFirst = result.variants.find((variant) => variant.name === "pitCacheSz").files[0].rows[0];
  assert.equal(szFirst.theme, "pit_cache_sz");
  assert.match(szFirst.reason, /period_market_variant_v1:pitCacheSz/);
  assert.match(szFirst.source, /period_market_variant_v1/);

  const chiNextRows = result.variants.find((variant) => variant.name === "pitCacheChiNext").files[1].rows;
  assert.deepEqual(chiNextRows.map((row) => row.code), ["300001", "301001"]);
  assert.match(chiNextRows[0].reason, /period_board_variant_v1:pitCacheChiNext/);
});

test("period universe variants runner writes period-universe directories and manifest", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-period-variants-"));
  const inputDir = path.join(tmp, "input");
  const outRoot = path.join(tmp, "out");
  writePitUniverse(path.join(inputDir, "pit_universe_2026-04-01.csv"), ROWS_0401);
  writePitUniverse(path.join(inputDir, "pit_universe_2026-05-04.csv"), ROWS_0504);

  const result = run(parseArgs(["--input-dir", inputDir, "--out-root", outRoot]));

  assert.equal(result.manifest.inputFileCount, 2);
  assert.equal(result.manifest.variants.length, 10);
  assert.ok(fs.existsSync(path.join(outRoot, "pit_cache_a_share", "pit_universe_2026-04-01.csv")));
  assert.ok(fs.existsSync(path.join(outRoot, "pit_cache_hk_connect", "pit_universe_2026-05-04.csv")));
  assert.ok(fs.existsSync(path.join(outRoot, "period_variant_manifest.json")));

  const rows = parseCsv(fs.readFileSync(path.join(outRoot, "pit_cache_a_share_ex_bj", "pit_universe_2026-04-01.csv"), "utf8"));
  assert.deepEqual(rows.map((row) => row.code), ["000001", "002001", "600001"]);

  const hkRows = parseCsv(fs.readFileSync(path.join(outRoot, "pit_cache_hk_connect", "pit_universe_2026-05-04.csv"), "utf8"));
  assert.equal(hkRows.length, 0);
  const starRows = parseCsv(fs.readFileSync(path.join(outRoot, "pit_cache_star", "pit_universe_2026-05-04.csv"), "utf8"));
  assert.deepEqual(starRows.map((row) => row.code), ["688001"]);

  const manifest = JSON.parse(fs.readFileSync(path.join(outRoot, "period_variant_manifest.json"), "utf8"));
  assert.equal(manifest.pointInTimePolicy, "variants_preserve_each_input_asOf_membership");
  assert.equal(manifest.variants.find((variant) => variant.name === "pitCacheA").totalRows, 7);
  assert.equal(manifest.variants.find((variant) => variant.name === "pitCacheStar").totalRows, 1);
});
