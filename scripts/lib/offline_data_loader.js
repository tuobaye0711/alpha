const fs = require("fs");
const path = require("path");

const { defaultOfflineDataDir } = require("./paths");
const { parseCsv } = require("./backtest_engine");

function latestMatchingDir(root, matcher, childPath) {
  if (!root || !fs.existsSync(root)) return "";
  const matches = fs.readdirSync(root)
    .filter((name) => matcher.test(name))
    .map((name) => path.join(root, name, childPath || ""))
    .filter((dir) => fs.existsSync(dir))
    .sort();
  return matches.at(-1) || "";
}

function resolveOfflineDataDirs(options = {}) {
  const offlineDataDir = path.resolve(options.offlineDataDir || defaultOfflineDataDir());
  return {
    offlineDataDir,
    qlibDir: options.qlibDir
      ? path.resolve(options.qlibDir)
      : latestMatchingDir(offlineDataDir, /^qlib_cn_\d+$/, "qlib_bin"),
    hkConnectHistoryDir: options.hkConnectHistoryDir
      ? path.resolve(options.hkConnectHistoryDir)
      : latestMatchingDir(offlineDataDir, /^hk_connect_tencent_.*\d+$/, "history_qfq_5y_completed"),
  };
}

function readFloat32Bin(file) {
  if (!file || !fs.existsSync(file)) return null;
  const buffer = fs.readFileSync(file);
  if (buffer.length < 8 || buffer.length % 4 !== 0) return null;
  const values = [];
  for (let offset = 0; offset < buffer.length; offset += 4) {
    values.push(buffer.readFloatLE(offset));
  }
  return {
    startIndex: Math.trunc(values[0]),
    values: values.slice(1),
  };
}

function qlibField(featureDir, field) {
  return readFloat32Bin(path.join(featureDir, `${field}.day.bin`));
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function addOptionalNumber(row, key, value) {
  const n = finiteNumber(value);
  if (n != null) row[key] = n;
}

function loadQlibKline(symbol, qlibDir) {
  if (!qlibDir) return null;
  const normalized = String(symbol || "").toLowerCase();
  if (!/^(sh|sz|bj)/.test(normalized)) return null;
  const calendarFile = path.join(qlibDir, "calendars", "day.txt");
  const featureDir = path.join(qlibDir, "features", normalized);
  if (!fs.existsSync(calendarFile) || !fs.existsSync(featureDir)) return null;

  const calendar = fs.readFileSync(calendarFile, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const fields = {
    open: qlibField(featureDir, "open"),
    close: qlibField(featureDir, "close"),
    high: qlibField(featureDir, "high"),
    low: qlibField(featureDir, "low"),
    volume: qlibField(featureDir, "volume"),
    amount: qlibField(featureDir, "amount"),
  };
  if (!fields.open || !fields.close || !fields.high || !fields.low) return null;

  const startIndex = fields.close.startIndex;
  const length = Math.min(
    fields.open.values.length,
    fields.close.values.length,
    fields.high.values.length,
    fields.low.values.length,
    fields.volume?.values.length ?? Infinity,
    fields.amount?.values.length ?? Infinity
  );
  const kline = [];
  for (let i = 0; i < length; i += 1) {
    const date = calendar[startIndex + i];
    const open = finiteNumber(fields.open.values[i]);
    const close = finiteNumber(fields.close.values[i]);
    const high = finiteNumber(fields.high.values[i]);
    const low = finiteNumber(fields.low.values[i]);
    if (!date || open == null || close == null || high == null || low == null) continue;
    const row = { date, open, close, high, low };
    addOptionalNumber(row, "volume", fields.volume?.values[i]);
    addOptionalNumber(row, "amount", fields.amount?.values[i]);
    kline.push(row);
  }
  if (!kline.length) return null;
  return {
    source: "qlib_cn_offline",
    symbol: normalized,
    qlibDir,
    kline,
  };
}

function loadHkConnectCsvKline(symbol, hkConnectHistoryDir) {
  if (!hkConnectHistoryDir) return null;
  const normalized = String(symbol || "").toLowerCase();
  if (!normalized.startsWith("hk")) return null;
  const file = path.join(hkConnectHistoryDir, `${normalized}.csv`);
  if (!fs.existsSync(file)) return null;

  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  const kline = rows
    .map((row) => {
      const out = {
        date: String(row.date || row.日期 || "").trim(),
        open: finiteNumber(row.open ?? row.开盘),
        close: finiteNumber(row.close ?? row.收盘),
        high: finiteNumber(row.high ?? row.最高),
        low: finiteNumber(row.low ?? row.最低),
      };
      addOptionalNumber(out, "volume", row.volume ?? row.成交量);
      addOptionalNumber(out, "amount", row.amount ?? row.成交额);
      return out;
    })
    .filter((row) => row.date && row.open != null && row.close != null && row.high != null && row.low != null)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!kline.length) return null;
  return {
    source: "hk_connect_tencent_offline",
    symbol: normalized,
    hkConnectHistoryDir,
    kline,
  };
}

function loadOfflineKlineForSymbol(symbol, options = {}) {
  const dirs = resolveOfflineDataDirs(options);
  return loadQlibKline(symbol, dirs.qlibDir) || loadHkConnectCsvKline(symbol, dirs.hkConnectHistoryDir);
}

module.exports = {
  loadHkConnectCsvKline,
  loadOfflineKlineForSymbol,
  loadQlibKline,
  resolveOfflineDataDirs,
};
