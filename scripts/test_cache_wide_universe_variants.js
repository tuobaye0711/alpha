const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { parseCsv } = require("./lib/backtest_engine");
const {
  buildVariants,
  parseArgs,
  run,
} = require("./build_cache_wide_universe_variants");

const FIXTURE_ROWS = [
  {
    theme: "cache_wide",
    code: "000001",
    name: "Ping An Bank",
    market: "深市",
    reason: "generated_from_local_cache",
    source: "local_kline_cache_520_qfq",
  },
  {
    theme: "cache_wide",
    code: "600000",
    name: "Shanghai Bank",
    market: "沪市",
    reason: "generated_from_local_cache",
    source: "local_kline_cache_520_qfq",
  },
  {
    theme: "cache_wide",
    code: "430001",
    name: "BJ Sample",
    market: "北交所/新三板系",
    reason: "generated_from_local_cache",
    source: "local_kline_cache_520_qfq",
  },
  {
    theme: "cache_wide",
    code: "09926",
    name: "HK Sample",
    market: "港股通",
    reason: "generated_from_local_cache",
    source: "local_kline_cache_520_qfq",
  },
  {
    theme: "cache_wide",
    code: "300001",
    name: "ChiNext Sample",
    market: "深市",
    reason: "generated_from_local_cache",
    source: "local_kline_cache_520_qfq",
  },
];

function writeFixtureCsv(file, rows = FIXTURE_ROWS) {
  const headers = ["theme", "code", "name", "market", "reason", "source"];
  fs.writeFileSync(
    file,
    [headers.join(","), ...rows.map((row) => headers.map((header) => row[header]).join(","))].join("\n")
  );
}

test("cache-wide universe variants split rows by static market structure", () => {
  const variants = buildVariants(FIXTURE_ROWS);

  assert.equal(variants.cacheWideA.rows.length, 4);
  assert.equal(variants.cacheWideAExBj.rows.length, 3);
  assert.equal(variants.cacheWideSz.rows.length, 2);
  assert.equal(variants.cacheWideSh.rows.length, 1);
  assert.equal(variants.cacheWideHk.rows.length, 1);
  assert.equal(variants.cacheWideA.rows[0].theme, "cache_wide_a_share");
  assert.match(variants.cacheWideA.rows[0].reason, /market_variant_v1:cacheWideA/);
  assert.match(variants.cacheWideA.rows[0].source, /market_variant_v1/);
  assert.deepEqual(
    variants.cacheWideA.rows.map((row) => row.code),
    ["000001", "600000", "430001", "300001"]
  );
});

test("cache-wide universe variants write csv outputs and manifest", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-cache-wide-variants-"));
  const input = path.join(tmp, "cache_wide.csv");
  const outDir = path.join(tmp, "out");
  writeFixtureCsv(input);

  const result = run(parseArgs(["--input", input, "--out-dir", outDir]));

  assert.equal(result.manifest.inputRowCount, 5);
  assert.equal(result.manifest.variants.length, 5);
  assert.equal(result.manifest.variants.find((row) => row.name === "cacheWideA").rowCount, 4);
  assert.ok(fs.existsSync(path.join(outDir, "cache_wide_a_share.csv")));
  assert.ok(fs.existsSync(path.join(outDir, "variant_manifest.json")));

  const aShareRows = parseCsv(fs.readFileSync(path.join(outDir, "cache_wide_a_share.csv"), "utf8"));
  assert.equal(aShareRows.length, 4);
  assert.equal(aShareRows[0].theme, "cache_wide_a_share");

  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "variant_manifest.json"), "utf8"));
  assert.equal(manifest.pointInTimePolicy, "membership_split_uses_static_market_field_only");
  assert.deepEqual(
    manifest.variants.map((row) => row.file),
    [
      "cache_wide_a_share.csv",
      "cache_wide_a_share_ex_bj.csv",
      "cache_wide_sz.csv",
      "cache_wide_sh.csv",
      "cache_wide_hk_connect.csv",
    ]
  );
});
