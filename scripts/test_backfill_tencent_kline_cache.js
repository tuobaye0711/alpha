const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  backfillTencentKlineCache,
  discoverTencentSymbols,
  parseArgs,
  parseTencentPayload,
} = require("./backfill_tencent_kline_cache");

function writePayload(cacheDir, symbol, lookback = 520) {
  const dir = path.join(cacheDir, "tencent");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${symbol}_${lookback}_qfq.json`),
    JSON.stringify({
      source: "tencent",
      symbol,
      fetchedAt: "2026-06-06T00:00:00.000Z",
      kline: [{ date: "2026-06-05", close: 10, volume: 1000 }],
    })
  );
}

test("discovers source Tencent symbols for a specific lookback", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-kline-backfill-discover-"));
  const cacheDir = path.join(tmp, "cache");
  writePayload(cacheDir, "sh600000", 520);
  writePayload(cacheDir, "sz000001", 520);
  writePayload(cacheDir, "sz000002", 900);

  assert.deepEqual(discoverTencentSymbols({ cacheDir, sourceLookback: 520 }), ["sh600000", "sz000001"]);
});

test("parses Tencent payload with market-specific volume units", () => {
  const json = {
    data: {
      sz000001: {
        qfqday: [
          ["2026-06-04", "10", "11", "12", "9", "123"],
          ["2026-06-05", "11", "12", "13", "10", "456"],
        ],
      },
    },
  };

  const rows = parseTencentPayload(json, "sz000001");

  assert.equal(rows.length, 2);
  assert.equal(rows[0].date, "2026-06-04");
  assert.equal(rows[0].close, 11);
  assert.equal(rows[0].volume, 12300);
});

test("backfills target lookback cache and skips existing files by default", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-kline-backfill-"));
  const cacheDir = path.join(tmp, "cache");
  writePayload(cacheDir, "sh600000", 520);
  writePayload(cacheDir, "sz000001", 520);
  writePayload(cacheDir, "sz000001", 900);
  const requested = [];

  const result = await backfillTencentKlineCache(
    parseArgs([
      "--cache-dir",
      cacheDir,
      "--source-lookback",
      "520",
      "--target-lookback",
      "900",
      "--concurrency",
      "2",
    ]),
    {
      requestText: async (url) => {
        requested.push(url);
        return JSON.stringify({
          data: {
            sh600000: {
              qfqday: [
                ["2026-06-04", "6", "6.1", "6.2", "5.9", "100"],
                ["2026-06-05", "6.1", "6.2", "6.3", "6.0", "200"],
              ],
            },
          },
        });
      },
      now: () => new Date("2026-06-08T00:00:00.000Z"),
    }
  );

  assert.equal(result.summary.totalSymbols, 2);
  assert.equal(result.summary.fetched, 1);
  assert.equal(result.summary.skippedExisting, 1);
  assert.equal(result.summary.failed, 0);
  assert.equal(requested.length, 1);
  assert.match(requested[0], /sh600000,day,,,900,qfq/);

  const payload = JSON.parse(fs.readFileSync(path.join(cacheDir, "tencent", "sh600000_900_qfq.json"), "utf8"));
  assert.equal(payload.source, "tencent");
  assert.equal(payload.symbol, "sh600000");
  assert.equal(payload.fetchedAt, "2026-06-08T00:00:00.000Z");
  assert.equal(payload.volumeUnitPolicy, "tencent_market_specific_volume_units_v2");
  assert.equal(payload.kline.length, 2);
  assert.ok(fs.existsSync(path.join(cacheDir, "kline_backfill_900_manifest.json")));
});
