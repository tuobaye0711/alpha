const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  loadOfflineKlineForSymbol,
  resolveOfflineDataDirs,
} = require("./lib/offline_data_loader");

function writeFloatBin(file, startIndex, values) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const buffer = Buffer.alloc((values.length + 1) * 4);
  buffer.writeFloatLE(startIndex, 0);
  values.forEach((value, index) => buffer.writeFloatLE(value, (index + 1) * 4));
  fs.writeFileSync(file, buffer);
}

test("offline loader reads Qlib A-share daily bins into engine kline rows", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-offline-qlib-"));
  const qlibDir = path.join(tmp, "qlib_bin");
  fs.mkdirSync(path.join(qlibDir, "calendars"), { recursive: true });
  fs.writeFileSync(
    path.join(qlibDir, "calendars", "day.txt"),
    ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07"].join("\n")
  );

  const featureDir = path.join(qlibDir, "features", "sh600001");
  writeFloatBin(path.join(featureDir, "open.day.bin"), 1, [10, 11, 12]);
  writeFloatBin(path.join(featureDir, "close.day.bin"), 1, [10.5, 11.5, 12.5]);
  writeFloatBin(path.join(featureDir, "high.day.bin"), 1, [10.8, 11.8, 12.8]);
  writeFloatBin(path.join(featureDir, "low.day.bin"), 1, [9.8, 10.8, 11.8]);
  writeFloatBin(path.join(featureDir, "volume.day.bin"), 1, [100, 120, 140]);
  writeFloatBin(path.join(featureDir, "amount.day.bin"), 1, [1000, 1400, 1800]);

  const payload = loadOfflineKlineForSymbol("sh600001", { qlibDir });
  const rounded = payload.kline.map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === "number" ? Number(value.toFixed(6)) : value,
    ])
  ));

  assert.equal(payload.source, "qlib_cn_offline");
  assert.equal(payload.symbol, "sh600001");
  assert.deepEqual(rounded, [
    { date: "2026-01-05", open: 10, close: 10.5, high: 10.8, low: 9.8, volume: 100, amount: 1000 },
    { date: "2026-01-06", open: 11, close: 11.5, high: 11.8, low: 10.8, volume: 120, amount: 1400 },
    { date: "2026-01-07", open: 12, close: 12.5, high: 12.8, low: 11.8, volume: 140, amount: 1800 },
  ]);
});

test("offline loader reads completed HK connect CSV rows", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-offline-hk-"));
  const hkConnectHistoryDir = path.join(tmp, "history_qfq_5y_completed");
  fs.mkdirSync(hkConnectHistoryDir, { recursive: true });
  fs.writeFileSync(
    path.join(hkConnectHistoryDir, "hk01810.csv"),
    [
      "date,open,close,high,low,volume",
      "2026-06-04,28.00,28.20,28.40,27.80,100000",
      "2026-06-05,27.60,27.80,28.00,27.30,120000",
    ].join("\n")
  );

  const payload = loadOfflineKlineForSymbol("hk01810", { hkConnectHistoryDir });

  assert.equal(payload.source, "hk_connect_tencent_offline");
  assert.equal(payload.symbol, "hk01810");
  assert.deepEqual(payload.kline, [
    { date: "2026-06-04", open: 28, close: 28.2, high: 28.4, low: 27.8, volume: 100000 },
    { date: "2026-06-05", open: 27.6, close: 27.8, high: 28, low: 27.3, volume: 120000 },
  ]);
});

test("offline data directory discovery picks the latest generated datasets", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-offline-discovery-"));
  fs.mkdirSync(path.join(tmp, "qlib_cn_20250101", "qlib_bin", "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "qlib_cn_20260607", "qlib_bin", "features"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "hk_connect_tencent_1500_20250101", "history_qfq_5y_completed"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "hk_connect_tencent_1500_20260608", "history_qfq_5y_completed"), { recursive: true });

  const dirs = resolveOfflineDataDirs({ offlineDataDir: tmp });

  assert.equal(dirs.qlibDir, path.join(tmp, "qlib_cn_20260607", "qlib_bin"));
  assert.equal(dirs.hkConnectHistoryDir, path.join(tmp, "hk_connect_tencent_1500_20260608", "history_qfq_5y_completed"));
});
