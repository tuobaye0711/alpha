const os = require("os");
const path = require("path");

function codexHome(env = process.env) {
  return env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(os.homedir(), ".codex");
}

function alphaDataHome(env = process.env) {
  return env.ALPHA_DATA_HOME ? path.resolve(env.ALPHA_DATA_HOME) : path.join(codexHome(env), "alpha");
}

function defaultCacheDir(env = process.env) {
  return path.join(alphaDataHome(env), "cache", "kline");
}

function defaultOutputRoot(env = process.env) {
  return path.join(alphaDataHome(env), "output");
}

function defaultOfflineDataDir(env = process.env) {
  return path.join(alphaDataHome(env), "cache", "offline_datasets");
}

module.exports = {
  alphaDataHome,
  codexHome,
  defaultCacheDir,
  defaultOfflineDataDir,
  defaultOutputRoot,
};
