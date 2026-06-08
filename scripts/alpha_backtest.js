#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const {
  auditUniverseFields,
  benchmarkReturn,
  defaultParams,
  evaluatePeriod,
  marketSymbol,
  mean,
  optimizeParams,
  paramGrid,
  parseCsv,
  walkForwardEnsembleOptimize,
  walkForwardOptimize,
  walkForwardPoolSelect,
  writeCsv,
} = require("./lib/backtest_engine");
const {
  defaultCacheDir,
  defaultOfflineDataDir,
  defaultOutputRoot,
} = require("./lib/paths");
const {
  loadOfflineKlineForSymbol,
  resolveOfflineDataDirs,
} = require("./lib/offline_data_loader");

const DEFAULT_OUTPUT_ROOT = defaultOutputRoot();
const DEFAULT_UNIVERSE = path.join(
  DEFAULT_OUTPUT_ROOT,
  "physical-ai-universe-20260604-1740",
  "physical_ai_core_candidates.csv"
);
const DEFAULT_CACHE_DIR = defaultCacheDir();
const DEFAULT_OFFLINE_DATA_DIR = defaultOfflineDataDir();
const TENCENT_VOLUME_UNIT_POLICY = "tencent_market_specific_volume_units_v2";

function usage() {
  return [
    "Usage: node alpha_backtest.js [options]",
    "",
    "Options:",
    "  --universe <csv[,csv2]>   股票池 CSV；可逗号分隔合并多个池，默认物理 AI core candidates",
    "  --period-universe-dir <dir> 按每个 period 的 asOf 读取 pit_universe_<asOf>.csv；用于近似 point-in-time 股票池",
    "  --period <asOf:end>       单个回测区间，例如 2026-04-01:2026-06-01",
    "  --periods <p1,p2>         多个区间，逗号分隔",
    "  --top <n>                 TopN，默认 10",
    "  --top-values <n,n>        同时测试多个 TopN 候选，例如 5,8,10；walk-forward 会用历史窗口选择 TopN",
    "  --lookback <days>         腾讯抓取条数/生产最小历史长度参考，默认 420",
    "  --min-history <days>      评分最小历史交易日，默认 65",
    "  --concurrency <n>         并发抓取数，默认 8",
    "  --limit <n>               只跑前 n 只，调试用",
    "  --provider <auto|tencent|eastmoney>",
    "  --benchmark <auto>        大盘基准，默认 auto 按市场映射",
    "  --out-dir <dir>           输出目录",
    "  --cache-dir <dir>         K 线缓存目录",
    "  --cache-only              只使用本地 K 线缓存，不联网；缺缓存样本记失败",
    "  --offline-data            优先使用本地离线训练数据（A股 Qlib + 港股通 CSV），缺失时按 cache/provider 回退",
    "  --offline-only            只使用离线训练数据和本地缓存，不联网；等价于 --offline-data --cache-only",
    "  --offline-data-dir <dir>  离线训练数据根目录，默认 $ALPHA_DATA_HOME/cache/offline_datasets",
    "  --qlib-dir <dir>          A股 Qlib qlib_bin 目录；未指定时在 offline-data-dir 下自动选择最新 qlib_cn_*",
    "  --hk-connect-history-dir <dir> 港股通 completed-only CSV 目录；未指定时自动选择最新 hk_connect_tencent_*",
    "  --refresh                 忽略缓存重新抓取",
    "  --no-costs                关闭交易成本/滑点模型，仅看毛收益",
    "  --cost-bps <n>            单次买入+卖出基础成本 bps，默认 35",
    "  --index-cost-bps <n>      指数袖珍仓位基础成本 bps，默认 8",
    "  --no-tradability          关闭入场可交易性约束，仅用于敏感性对照",
    "  --min-entry-turnover <n>  入场日最小成交额过滤，默认 0",
    "  --max-exit-delay-days <n> 目标退出日不可卖出时最多顺延交易日，默认 3",
    "  --universe-filter         开启 asOf 动态股票池过滤，默认关闭",
    "  --no-universe-filter      关闭 asOf 动态股票池过滤",
    "  --min-universe-turnover <n> 20日均成交额动态过滤；设置后自动开启，默认 20000000",
    "  --min-universe-price <n>  asOf 收盘价动态过滤；设置后自动开启，默认 1",
    "  --max-universe-vol <n>    20日年化波动率动态过滤；设置后自动开启，默认 2.8",
    "  --exclude-st-universe     动态股票池排除名称含 ST 的标的，并自动开启",
    "  --dynamic-group-filter    开启 asOf 动态行业/主题强度过滤，默认关闭",
    "  --dynamic-group-by <industry|concept|both|source> 动态强度分组口径，默认 industry；source 使用 universeSource/source 作为来源池轮动口径",
    "  --min-dynamic-group-size <n> 动态分组最小样本数；设置后自动开启，默认 8",
    "  --min-dynamic-group-score <n> 动态分组最低强度分；设置后自动开启，默认 55",
    "  --min-dynamic-group-breadth <n> 动态分组20日上涨宽度；设置后自动开启，默认 0.45",
    "  --min-dynamic-group-remaining <n> 动态过滤后最低保留样本数；低于该值自动回原池，默认当前 TopN",
    "  --no-static-theme         关闭静态主题/行业信号，仅保留K线、指数和交易约束；用于当前概念快照穿越敏感性对照",
    "  --include-no-static-params 在参数池中追加 _no_static_theme 克隆，让walk-forward自行选择是否关闭静态主题/行业",
    "  --include-no-static-param-names <a,b> 只在参数池中追加指定参数的 _no_static_theme 克隆，用于窄开穿越风险反证候选",
    "  --ensemble-top-k <n>      Walk-forward 子策略组合 TopK，默认 1",
    "  --ensemble-weighting <equal|score|risk> 子策略组合权重方式，默认 equal",
    "  --ensemble-score-temperature <n> score 权重 softmax 温度，默认 20",
    "  --wf-stable-param <name> Walk-forward 生产 incumbent；challenger 需超过切换门槛才替换",
    "  --wf-switch-margin <n>  Walk-forward 切换门槛，训练稳健分领先不足该值则保留 incumbent，默认 0",
    "  --wf-incumbent-policy <rolling|stable> incumbent 口径；rolling=切换后延续当前 sleeve，stable=每期重新对生产基线比较，默认 rolling",
    "  --wf-current-gate <off|fresh-v1|regime-v1|regime-v2|regime-v3|regime-v4|regime-v5|regime-v6|regime-v7|regime-v8|regime-v9|regime-v10|regime-v11|regime-v12|regime-v13|regime-v14|regime-v15|regime-v16|regime-v17|regime-v18|regime-v19|regime-v20|regime-v21|regime-v22|regime-v23|regime-v24|regime-v25|regime-v26|regime-v27|regime-v28|regime-v29|regime-v30|regime-v31|regime-v32> Walk-forward 当前篮子质量门禁；fresh-v1 只看 asOf TopN 指标，regime-v1 追加指数过热现金 overlay，regime-v2 追加成熟动量现金 overlay，regime-v3 追加上一期跑输后的 beta 修复 overlay，regime-v4 追加更强 beta 修复 overlay，regime-v5 将温和基准下的成熟动量 overlay 转为指数袖珍仓位，regime-v6 追加指数短期回踩后的补涨袖珍仓位，regime-v7 提高成熟动量温和基准轮动袖珍仓位，regime-v8 允许 benchmark-state attack 后的轻度跑输触发 beta recovery，regime-v9 在强 beta 进攻前增加行业残差质量门禁，regime-v10 在该门禁前优先保留 beta recovery，regime-v11 在过热基准下允许高 fresh 篮子先于成熟动量 overlay 接管，regime-v12 在 v11 fresh 接管后允许适中 fresh 的 lottery guard overlay，regime-v13 在中期上行但短期回踩的基准环境允许相对强 v32 接管，regime-v14 在 fresh 20日过度延展但相对/行业残差确认不足时回落到成熟 beta，regime-v15 在指数不过热、中期仍上行、v54 中等 fresh 且行业残差很强时允许 fresh continuation 接管，regime-v16 在指数主升且 v32 广谱相对强但不过度拥挤时允许 broad beta attack 接管，regime-v17 在 v54 fresh 接管但 v32 早期广谱 beta 更强且不过热时允许 v32 接管，regime-v18 在成熟/fresh 高位降速且波动抬升时允许 crash-cash overlay，regime-v19 在 v62 pullback catch-up 已触发且 v59 指数袖珍仓位明显更强时允许 beta sleeve 升级，regime-v20 在 v59 beta recovery 已触发且高置信指数仓位明显更强时允许进一步提高 beta sleeve，regime-v21 在 v54 中等 fresh 且 v64 显著压降 lottery/MAX 风险时允许直接 lottery guard，regime-v22 在 v54 高 fresh 但行业残差确认弱、v52 低波动稳定短反时允许切到 v52，regime-v23 在 v54 直接 fresh 切换但当期 fresh/量能确认弱、v28 中等量能动量且低 lottery 时允许切到 v28，regime-v24 在 v51 稳定基线已保留但 v52 呈现中等 fresh、相对强、换手稳定且低尖峰时允许切到 v52，regime-v25 在 v32 指数回踩进攻后允许强相对低尖峰 v28 接管，regime-v26 在 v64 fresh-rotation lottery guard 高 fresh 但相对动量和换手稳定不足时允许 v52 接管，regime-v27 在 fresh 过度延展回落到 v63 后、弱指数背景下允许低波动稳定 v52 接管，regime-v28 在 v32 回踩进攻后、v28 具备高行业残差确认和量能动量且入场不过热时允许接管，regime-v29 在宽池早期修复且 v52 稳定短反 breadth 充分时允许接管，regime-v30 在宽池深回踩 v32 进攻后且 v52 稳定短反确认更充分时允许接管，regime-v31 在宽池早期强量能且指数 60 日未过热时允许 v28 接管，regime-v32 在窄池早期强势但静态主题可能拖累时允许 v63_no_static 接管，默认 off",
    "  --wf-known-outcome-only  Walk-forward 训练只使用 end<=当前 asOf 的已完成窗口，防止重叠持有窗口泄漏",
    "  --pool-selector-dirs <name=dir,...> 读取多个已完成回测目录的 walk_forward_summary.csv，做池级动态选择并退出",
    "  --pool-selector-lookback <n> 池级选择训练回看窗口，默认 6",
    "  --pool-selector-min-train <n> 池级选择开始训练窗口数，默认 6",
    "  --pool-selector-initial <name> warmup 期默认股票池，默认第一个 pool",
    "  --pool-selector-baseline <name> 固定基线池；pool_selector_summary 会输出相对该池的成对收益差",
    "  --pool-selector-current-feature-gate <off|physical-relative-v1|physical-relative-wf-v1|physical-relative-wf-v2|physical-relative-wf-v3> 用当前TopN特征做池级选择，不读取未来收益；physical-relative-v1要求physical相对baseline动量优势；physical-relative-wf-v1只用已完成历史窗口选择特征阈值；physical-relative-wf-v2追加R60/基准20日/换手稳定优势阈值；physical-relative-wf-v3要求基准20日/换手稳定触发同时满足R60相对优势底线",
    "  --pool-selector-current-risk-gate <off|relative-trend-crowding-v1|relative-trend-crowding-v2|relative-trend-crowding-v3|relative-trend-crowding-v4|relative-trend-crowding-v5> 池级选择后置当前风险门禁；v1在弱相对趋势、fresh补偿不足且拥挤/换手稳定性恶化时回退baseline；v2追加fresh显著落后但尖峰拥挤抬升的后段切换拦截；v3要求低fresh切换具备风险降低或基准确认；v4先对创业板/科创板/主板等板块池做当前确认，失败后回退非板块池再执行v3；v5拦截相对趋势软弱且lottery风险未降低的非确认切换",
    "  --pool-selector-score-excess-weight <n> 池级净超大盘权重，默认 0.35",
    "  --pool-selector-incumbent-policy <off|rolling> 池级 incumbent 口径；rolling=领先不足切换门槛则保留上期池，默认 off",
    "  --pool-selector-switch-margin <n> 池级切换门槛，训练分领先不足该值则保留 incumbent，默认 0",
    "  --pool-selector-known-outcome-only 池级选择只使用 end<=当前 asOf 的已完成池级窗口",
    "  --pool-selector-include-warmup 输出 warmup 期 initial pool 结果，便于和 fixed pool 同口径比较",
    "  --wf-min-exploratory-periods <n> rank_ 等探索参数至少积累 n 个训练区间后才参与竞选，默认关闭",
    "  --include-experimental-params 纳入实验参数组参与优化，默认不纳入",
    "  --param-names <a,b>       只使用指定参数组；用于隔离测试单个因子，可直接选择 experimental 参数",
    "  --no-optimize             只跑默认参数",
    "  --help",
  ].join("\n");
}

function parsePoolSelectorDirs(value) {
  const seen = new Set();
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const separator = item.indexOf("=");
      if (separator <= 0 || separator === item.length - 1) {
        throw new Error("--pool-selector-dirs entries must be name=dir");
      }
      const name = item.slice(0, separator).trim();
      const dir = item.slice(separator + 1).trim();
      if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        throw new Error(`Invalid --pool-selector-dirs name: ${name}`);
      }
      if (seen.has(name)) {
        throw new Error(`Duplicate --pool-selector-dirs name: ${name}`);
      }
      seen.add(name);
      return { name, dir: path.resolve(dir) };
    });
}

function parseArgs(argv) {
  const args = {
    universe: DEFAULT_UNIVERSE,
    periodUniverseDir: "",
    periods: ["2026-04-01:2026-06-01"],
    top: 10,
    topValues: [],
    topValuesProvided: false,
    lookback: 420,
    minHistory: 65,
    concurrency: 8,
    provider: "auto",
    benchmark: "auto",
    cacheDir: DEFAULT_CACHE_DIR,
    cacheOnly: false,
    offlineData: false,
    offlineOnly: false,
    offlineDataDir: DEFAULT_OFFLINE_DATA_DIR,
    qlibDir: "",
    hkConnectHistoryDir: "",
    refresh: false,
    optimize: true,
    costs: true,
    costBps: 35,
    indexCostBps: 8,
    tradability: true,
    minEntryTurnover: 0,
    maxExitDelayDays: 3,
    universeFilter: false,
    minUniverseTurnover: 20_000_000,
    minUniversePrice: 1,
    maxUniverseVol: 2.8,
    excludeSTUniverse: false,
    dynamicGroupFilter: false,
    dynamicGroupBy: "industry",
    minDynamicGroupSize: 8,
    minDynamicGroupScore: 55,
    minDynamicGroupBreadth: 0.45,
    minDynamicGroupRemaining: 0,
    noStaticTheme: false,
    includeNoStaticParams: false,
    noStaticParamNames: [],
    ensembleTopK: 1,
    ensembleWeighting: "equal",
    ensembleScoreTemperature: 20,
    walkForwardStableParam: "",
    walkForwardSwitchMargin: 0,
    walkForwardIncumbentPolicy: "rolling",
    walkForwardCurrentGate: "off",
    walkForwardMinExploratoryPeriods: 0,
    walkForwardKnownOutcomeOnly: false,
    includeExperimentalParams: false,
    paramNames: [],
    poolSelectorDirs: [],
    poolSelectorLookback: 6,
    poolSelectorMinTrain: 6,
    poolSelectorInitialPool: "",
    poolSelectorBaselinePool: "",
    poolSelectorCurrentFeatureGate: "off",
    poolSelectorCurrentRiskGate: "off",
    poolSelectorScoreExcessWeight: 0.35,
    poolSelectorIncumbentPolicy: "off",
    poolSelectorSwitchMargin: 0,
    poolSelectorKnownOutcomeOnly: false,
    poolSelectorIncludeWarmup: false,
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
    } else if (arg === "--universe") {
      args.universe = next();
    } else if (arg === "--period-universe-dir") {
      args.periodUniverseDir = path.resolve(next());
    } else if (arg === "--period") {
      args.periods = [next()];
    } else if (arg === "--periods") {
      args.periods = next().split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg === "--top") {
      args.top = Number(next());
    } else if (arg === "--top-values") {
      args.topValuesProvided = true;
      args.topValues = next()
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number);
    } else if (arg === "--lookback") {
      args.lookback = Number(next());
    } else if (arg === "--min-history") {
      args.minHistory = Number(next());
    } else if (arg === "--concurrency") {
      args.concurrency = Number(next());
    } else if (arg === "--limit") {
      args.limit = Number(next());
    } else if (arg === "--provider") {
      args.provider = next();
    } else if (arg === "--benchmark") {
      args.benchmark = next();
    } else if (arg === "--out-dir") {
      args.outDir = path.resolve(next());
    } else if (arg === "--cache-dir") {
      args.cacheDir = path.resolve(next());
    } else if (arg === "--cache-only") {
      args.cacheOnly = true;
    } else if (arg === "--offline-data") {
      args.offlineData = true;
    } else if (arg === "--offline-only") {
      args.offlineOnly = true;
      args.offlineData = true;
      args.cacheOnly = true;
    } else if (arg === "--offline-data-dir") {
      args.offlineDataDir = path.resolve(next());
    } else if (arg === "--qlib-dir") {
      args.qlibDir = path.resolve(next());
    } else if (arg === "--hk-connect-history-dir") {
      args.hkConnectHistoryDir = path.resolve(next());
    } else if (arg === "--refresh") {
      args.refresh = true;
    } else if (arg === "--no-costs") {
      args.costs = false;
    } else if (arg === "--cost-bps") {
      args.costBps = Number(next());
    } else if (arg === "--index-cost-bps") {
      args.indexCostBps = Number(next());
    } else if (arg === "--no-tradability") {
      args.tradability = false;
    } else if (arg === "--min-entry-turnover") {
      args.minEntryTurnover = Number(next());
    } else if (arg === "--max-exit-delay-days") {
      args.maxExitDelayDays = Number(next());
    } else if (arg === "--universe-filter") {
      args.universeFilter = true;
    } else if (arg === "--no-universe-filter") {
      args.universeFilter = false;
    } else if (arg === "--min-universe-turnover") {
      args.universeFilter = true;
      args.minUniverseTurnover = Number(next());
    } else if (arg === "--min-universe-price") {
      args.universeFilter = true;
      args.minUniversePrice = Number(next());
    } else if (arg === "--max-universe-vol") {
      args.universeFilter = true;
      args.maxUniverseVol = Number(next());
    } else if (arg === "--exclude-st-universe") {
      args.universeFilter = true;
      args.excludeSTUniverse = true;
    } else if (arg === "--dynamic-group-filter") {
      args.universeFilter = true;
      args.dynamicGroupFilter = true;
    } else if (arg === "--no-dynamic-group-filter") {
      args.dynamicGroupFilter = false;
    } else if (arg === "--dynamic-group-by") {
      args.universeFilter = true;
      args.dynamicGroupFilter = true;
      args.dynamicGroupBy = next();
    } else if (arg === "--min-dynamic-group-size") {
      args.universeFilter = true;
      args.dynamicGroupFilter = true;
      args.minDynamicGroupSize = Number(next());
    } else if (arg === "--min-dynamic-group-score") {
      args.universeFilter = true;
      args.dynamicGroupFilter = true;
      args.minDynamicGroupScore = Number(next());
    } else if (arg === "--min-dynamic-group-breadth") {
      args.universeFilter = true;
      args.dynamicGroupFilter = true;
      args.minDynamicGroupBreadth = Number(next());
    } else if (arg === "--min-dynamic-group-remaining") {
      args.universeFilter = true;
      args.dynamicGroupFilter = true;
      args.minDynamicGroupRemaining = Number(next());
    } else if (arg === "--no-static-theme") {
      args.noStaticTheme = true;
    } else if (arg === "--include-no-static-params") {
      args.includeNoStaticParams = true;
    } else if (arg === "--include-no-static-param-names") {
      args.noStaticParamNames = next().split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg === "--ensemble-top-k") {
      args.ensembleTopK = Number(next());
    } else if (arg === "--ensemble-weighting") {
      args.ensembleWeighting = next();
    } else if (arg === "--ensemble-score-temperature") {
      args.ensembleScoreTemperature = Number(next());
    } else if (arg === "--wf-stable-param") {
      args.walkForwardStableParam = next();
    } else if (arg === "--wf-switch-margin") {
      args.walkForwardSwitchMargin = Number(next());
    } else if (arg === "--wf-incumbent-policy") {
      args.walkForwardIncumbentPolicy = next();
    } else if (arg === "--wf-current-gate") {
      args.walkForwardCurrentGate = next();
    } else if (arg === "--pool-selector-dirs") {
      args.poolSelectorDirs = parsePoolSelectorDirs(next());
    } else if (arg === "--pool-selector-lookback") {
      args.poolSelectorLookback = Number(next());
    } else if (arg === "--pool-selector-min-train") {
      args.poolSelectorMinTrain = Number(next());
    } else if (arg === "--pool-selector-initial") {
      args.poolSelectorInitialPool = next();
    } else if (arg === "--pool-selector-baseline") {
      args.poolSelectorBaselinePool = next();
    } else if (arg === "--pool-selector-current-feature-gate") {
      args.poolSelectorCurrentFeatureGate = next();
    } else if (arg === "--pool-selector-current-risk-gate") {
      args.poolSelectorCurrentRiskGate = next();
    } else if (arg === "--pool-selector-score-excess-weight") {
      args.poolSelectorScoreExcessWeight = Number(next());
    } else if (arg === "--pool-selector-incumbent-policy") {
      args.poolSelectorIncumbentPolicy = next();
    } else if (arg === "--pool-selector-switch-margin") {
      args.poolSelectorSwitchMargin = Number(next());
    } else if (arg === "--pool-selector-known-outcome-only") {
      args.poolSelectorKnownOutcomeOnly = true;
    } else if (arg === "--pool-selector-include-warmup") {
      args.poolSelectorIncludeWarmup = true;
    } else if (arg === "--wf-min-exploratory-periods") {
      args.walkForwardMinExploratoryPeriods = Number(next());
    } else if (arg === "--wf-known-outcome-only") {
      args.walkForwardKnownOutcomeOnly = true;
    } else if (arg === "--include-experimental-params") {
      args.includeExperimentalParams = true;
    } else if (arg === "--param-names") {
      args.paramNames = next().split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg === "--no-optimize") {
      args.optimize = false;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!["auto", "tencent", "eastmoney"].includes(args.provider)) {
    throw new Error("--provider must be auto, tencent, or eastmoney");
  }
  if (args.benchmark !== "auto") {
    throw new Error("--benchmark currently supports only auto");
  }
  for (const key of ["top", "lookback", "minHistory", "concurrency"]) {
    if (!Number.isFinite(args[key]) || args[key] <= 0) throw new Error(`Invalid --${key}`);
  }
  if (!Number.isInteger(args.top)) throw new Error("Invalid --top");
  if (args.topValuesProvided && !args.topValues.length) {
    throw new Error("Invalid --top-values");
  }
  if (args.topValues.length) {
    const topValues = [];
    const seenTopValues = new Set();
    for (const value of args.topValues) {
      if (!Number.isInteger(value) || value <= 0) throw new Error("Invalid --top-values");
      if (!seenTopValues.has(value)) {
        seenTopValues.add(value);
        topValues.push(value);
      }
    }
    args.topValues = topValues.sort((a, b) => a - b);
  }
  for (const key of ["costBps", "indexCostBps"]) {
    if (!Number.isFinite(args[key]) || args[key] < 0) throw new Error(`Invalid --${key}`);
  }
  if (!Number.isFinite(args.minEntryTurnover) || args.minEntryTurnover < 0) {
    throw new Error("Invalid --min-entry-turnover");
  }
  if (!Number.isFinite(args.maxExitDelayDays) || args.maxExitDelayDays < 0) {
    throw new Error("Invalid --max-exit-delay-days");
  }
  args.dynamicGroupBy = String(args.dynamicGroupBy || "industry").toLowerCase();
  if (args.dynamicGroupBy === "concepts") args.dynamicGroupBy = "concept";
  if (args.dynamicGroupBy === "sources" || args.dynamicGroupBy === "universe" || args.dynamicGroupBy === "universe_source") {
    args.dynamicGroupBy = "source";
  }
  if (!["industry", "concept", "both", "source"].includes(args.dynamicGroupBy)) {
    throw new Error("--dynamic-group-by must be industry, concept, both, or source");
  }
  if (!Number.isFinite(args.minDynamicGroupSize) || args.minDynamicGroupSize <= 0) {
    throw new Error("Invalid --min-dynamic-group-size");
  }
  if (!Number.isInteger(args.minDynamicGroupSize)) {
    throw new Error("Invalid --min-dynamic-group-size");
  }
  if (!Number.isFinite(args.minDynamicGroupScore) || args.minDynamicGroupScore < 0 || args.minDynamicGroupScore > 100) {
    throw new Error("Invalid --min-dynamic-group-score");
  }
  if (!Number.isFinite(args.minDynamicGroupBreadth) || args.minDynamicGroupBreadth < 0 || args.minDynamicGroupBreadth > 1) {
    throw new Error("Invalid --min-dynamic-group-breadth");
  }
  if (!Number.isFinite(args.minDynamicGroupRemaining) || args.minDynamicGroupRemaining < 0) {
    throw new Error("Invalid --min-dynamic-group-remaining");
  }
  if (!Number.isInteger(args.minDynamicGroupRemaining)) {
    throw new Error("Invalid --min-dynamic-group-remaining");
  }
  if (!Number.isFinite(args.ensembleTopK) || args.ensembleTopK <= 0) {
    throw new Error("Invalid --ensemble-top-k");
  }
  if (args.ensembleWeighting === "score-softmax") args.ensembleWeighting = "score";
  if (!["equal", "score", "risk"].includes(args.ensembleWeighting)) {
    throw new Error("--ensemble-weighting must be equal, score, or risk");
  }
  if (!Number.isFinite(args.ensembleScoreTemperature) || args.ensembleScoreTemperature <= 0) {
    throw new Error("Invalid --ensemble-score-temperature");
  }
  if (!Number.isFinite(args.walkForwardSwitchMargin) || args.walkForwardSwitchMargin < 0) {
    throw new Error("Invalid --wf-switch-margin");
  }
  if (!["rolling", "stable"].includes(args.walkForwardIncumbentPolicy)) {
    throw new Error("--wf-incumbent-policy must be rolling or stable");
  }
  if (!["off", "fresh-v1", "regime-v1", "regime-v2", "regime-v3", "regime-v4", "regime-v5", "regime-v6", "regime-v7", "regime-v8", "regime-v9", "regime-v10", "regime-v11", "regime-v12", "regime-v13", "regime-v14", "regime-v15", "regime-v16", "regime-v17", "regime-v18", "regime-v19", "regime-v20", "regime-v21", "regime-v22", "regime-v23", "regime-v24", "regime-v25", "regime-v26", "regime-v27", "regime-v28", "regime-v29", "regime-v30", "regime-v31", "regime-v32"].includes(args.walkForwardCurrentGate)) {
    throw new Error("--wf-current-gate must be off, fresh-v1, regime-v1, regime-v2, regime-v3, regime-v4, regime-v5, regime-v6, regime-v7, regime-v8, regime-v9, regime-v10, regime-v11, regime-v12, regime-v13, regime-v14, regime-v15, regime-v16, regime-v17, regime-v18, regime-v19, regime-v20, regime-v21, regime-v22, regime-v23, regime-v24, regime-v25, regime-v26, regime-v27, regime-v28, regime-v29, regime-v30, regime-v31, or regime-v32");
  }
  if (args.walkForwardIncumbentPolicy === "stable" && !args.walkForwardStableParam) {
    throw new Error("--wf-incumbent-policy stable requires --wf-stable-param");
  }
  if (!Number.isFinite(args.walkForwardMinExploratoryPeriods) || args.walkForwardMinExploratoryPeriods < 0) {
    throw new Error("Invalid --wf-min-exploratory-periods");
  }
  args.walkForwardMinExploratoryPeriods = Math.floor(args.walkForwardMinExploratoryPeriods);
  if (args.poolSelectorDirs.length) {
    if (!Number.isInteger(args.poolSelectorLookback) || args.poolSelectorLookback <= 0) {
      throw new Error("Invalid --pool-selector-lookback");
    }
    if (!Number.isInteger(args.poolSelectorMinTrain) || args.poolSelectorMinTrain <= 0) {
      throw new Error("Invalid --pool-selector-min-train");
    }
    if (!Number.isFinite(args.poolSelectorScoreExcessWeight)) {
      throw new Error("Invalid --pool-selector-score-excess-weight");
    }
    args.poolSelectorIncumbentPolicy = String(args.poolSelectorIncumbentPolicy || "off").toLowerCase();
    if (!["off", "rolling"].includes(args.poolSelectorIncumbentPolicy)) {
      throw new Error("--pool-selector-incumbent-policy must be off or rolling");
    }
    if (!Number.isFinite(args.poolSelectorSwitchMargin) || args.poolSelectorSwitchMargin < 0) {
      throw new Error("Invalid --pool-selector-switch-margin");
    }
    args.poolSelectorCurrentRiskGate = String(args.poolSelectorCurrentRiskGate || "off").toLowerCase();
    if (!["off", "relative-trend-crowding-v1", "relative-trend-crowding-v2", "relative-trend-crowding-v3", "relative-trend-crowding-v4", "relative-trend-crowding-v5"].includes(args.poolSelectorCurrentRiskGate)) {
      throw new Error("--pool-selector-current-risk-gate must be off, relative-trend-crowding-v1, relative-trend-crowding-v2, relative-trend-crowding-v3, relative-trend-crowding-v4, or relative-trend-crowding-v5");
    }
    if (
      args.poolSelectorInitialPool &&
      !args.poolSelectorDirs.some((pool) => pool.name === args.poolSelectorInitialPool)
    ) {
      throw new Error(`Unknown --pool-selector-initial: ${args.poolSelectorInitialPool}`);
    }
  }
  if (!Array.isArray(args.paramNames)) args.paramNames = [];
  for (const key of ["minUniverseTurnover", "minUniversePrice", "maxUniverseVol"]) {
    if (!Number.isFinite(args[key]) || args[key] < 0) throw new Error(`Invalid --${key}`);
  }
  return args;
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function normalizeCode(row) {
  const raw = String(row.code || row.SECURITY_CODE || row.symbol || "").trim();
  const market = String(row.market || row.MARKET || "");
  if (/港/.test(market) || /^\d{5}$/.test(raw)) return raw.padStart(5, "0");
  return raw.padStart(6, "0");
}

function mergePipeValues(a, b) {
  const values = new Set();
  for (const value of [a, b]) {
    String(value || "")
      .split("|")
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((item) => values.add(item));
  }
  return Array.from(values).join("|");
}

function strongerRelevance(a, b) {
  const rank = (value) => {
    const text = String(value || "");
    if (/核心/.test(text)) return 3;
    if (/相关|候选|接口/.test(text)) return 2;
    return text ? 1 : 0;
  };
  return rank(b) > rank(a) ? b : a;
}

function normalizeUniverse(rows) {
  const seen = new Map();
  const normalized = [];
  for (const row of rows) {
    const code = normalizeCode(row);
    if (!code) continue;
    const item = {
      ...row,
      code,
      name: row.name || row.SECURITY_NAME_ABBR || row.security_name || "",
      market: row.market || row.MARKET || "",
      industry: row.industry || row.INDUSTRY || "",
      concepts: row.concepts || row.CONCEPTS || "",
      relevance: row.relevance || row.RELEVANCE || "",
      source: row.source || "",
      universeSource: row.universeSource || row.universe_file || "",
    };
    if (seen.has(code)) {
      const existing = seen.get(code);
      existing.name = existing.name || item.name;
      existing.market = existing.market || item.market;
      existing.industry = existing.industry || item.industry;
      existing.concepts = mergePipeValues(existing.concepts, item.concepts);
      existing.source = mergePipeValues(existing.source, item.source);
      existing.universeSource = mergePipeValues(existing.universeSource, item.universeSource);
      existing.relevance = strongerRelevance(existing.relevance, item.relevance);
      continue;
    }
    seen.set(code, item);
    normalized.push(item);
  }
  return normalized;
}

function universeFilesFromArg(value) {
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));
}

function loadUniverseFromFiles(value) {
  const files = universeFilesFromArg(value);
  if (!files.length) throw new Error("No universe files specified");
  const rows = [];
  for (const file of files) {
    const sourceName = path.basename(file);
    const parsed = parseCsv(fs.readFileSync(file, "utf8"));
    for (const row of parsed) rows.push({ ...row, universeSource: sourceName });
  }
  return { universeFiles: files, universeRows: normalizeUniverse(rows) };
}

function periodKey(period) {
  return `${period.asOf}:${period.end}`;
}

function periodUniverseFile(dir, asOf) {
  return path.join(dir, `pit_universe_${asOf}.csv`);
}

function loadPeriodUniverseSet(periods, dir) {
  const periodUniverseRowsByKey = new Map();
  const universeFiles = [];
  const allRows = [];
  for (const period of periods) {
    const file = periodUniverseFile(dir, period.asOf);
    if (!fs.existsSync(file)) throw new Error(`Missing period universe file: ${file}`);
    const sourceName = path.basename(file);
    const parsed = parseCsv(fs.readFileSync(file, "utf8"));
    const rows = normalizeUniverse(parsed.map((row) => ({ ...row, universeSource: sourceName })));
    periodUniverseRowsByKey.set(periodKey(period), rows);
    universeFiles.push(file);
    allRows.push(...rows);
  }
  return {
    mode: "period",
    universeFiles,
    universeRows: normalizeUniverse(allRows),
    periodUniverseRowsByKey,
  };
}

function loadUniverseSet(args, periods) {
  if (args.periodUniverseDir) return loadPeriodUniverseSet(periods, args.periodUniverseDir);
  const loaded = loadUniverseFromFiles(args.universe);
  return {
    mode: "static",
    universeFiles: loaded.universeFiles,
    universeRows: loaded.universeRows,
    periodUniverseRowsByKey: null,
  };
}

function applyUniverseLimit(rows, limit) {
  return Number.isFinite(limit) ? rows.slice(0, limit) : rows;
}

function updateFetchWindow(fetchWindowByCode, row, period) {
  const current = fetchWindowByCode.get(row.code);
  if (!current) {
    fetchWindowByCode.set(row.code, { minAsOf: period.asOf, maxEnd: period.end });
    return;
  }
  if (period.asOf < current.minAsOf) current.minAsOf = period.asOf;
  if (period.end > current.maxEnd) current.maxEnd = period.end;
}

function prepareRunUniverses(args, periods, universeSet = loadUniverseSet(args, periods)) {
  const periodUniverseRowsByKey = new Map();
  const fetchRows = [];
  const fetchWindowByCode = new Map();
  const periodUniverseCounts = [];
  for (const period of periods) {
    const key = periodKey(period);
    const baseRows = universeSet.periodUniverseRowsByKey?.get(key) || universeSet.universeRows;
    if (!baseRows) throw new Error(`Missing universe rows for period: ${key}`);
    const rows = applyUniverseLimit(baseRows, args.limit);
    periodUniverseRowsByKey.set(key, rows);
    periodUniverseCounts.push({ period: key, asOf: period.asOf, rowCount: rows.length });
    for (const row of rows) {
      fetchRows.push(row);
      updateFetchWindow(fetchWindowByCode, row, period);
    }
  }
  return {
    mode: universeSet.mode,
    universeFiles: universeSet.universeFiles,
    universeRows: universeSet.universeRows,
    periodUniverseRowsByKey,
    periodUniverseCounts,
    fetchUniverse: normalizeUniverse(fetchRows),
    fetchWindowByCode,
  };
}

function guessUniverseSnapshotDate(files) {
  const dates = [];
  for (const file of files) {
    const isoMatch = String(file).match(/(20\d{2}-\d{2}-\d{2})/);
    if (isoMatch) {
      dates.push(isoMatch[1]);
      continue;
    }
    const match = String(file).match(/(20\d{6})/);
    if (!match) continue;
    const raw = match[1];
    dates.push(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`);
  }
  return dates.sort().at(-1) || "";
}

function parsePeriods(periodStrings) {
  return periodStrings.map((item) => {
    const [asOf, end] = item.split(":").map((s) => s.trim());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      throw new Error(`Invalid period: ${item}`);
    }
    if (asOf >= end) throw new Error(`Period asOf must be before end: ${item}`);
    return { asOf, end };
  });
}

function addDays(dateText, delta) {
  const d = new Date(`${dateText}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function compactDate(dateText) {
  return dateText.replace(/-/g, "");
}

function minDate(values) {
  return values.slice().sort()[0];
}

function maxDate(values) {
  return values.slice().sort().at(-1);
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

function pct(value) {
  if (!Number.isFinite(value)) return "";
  return `${(value * 100).toFixed(2)}%`;
}

function round(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : "";
}

function erfApprox(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax));
  return sign * y;
}

function normalCdfApprox(x) {
  return 0.5 * (1 + erfApprox(x / Math.SQRT2));
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function readCache(file, refresh) {
  if (refresh || !fs.existsSync(file)) return null;
  try {
    return normalizeCachedKlinePayload(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

function writeCache(file, payload) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
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

async function requestText(url, headers = {}, timeoutMs = 16000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 AlphaBacktest/1.0",
        ...headers,
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (fetchError) {
    const curlArgs = ["-L", "--connect-timeout", "8", "--max-time", String(Math.ceil(timeoutMs / 1000)), "-sS"];
    for (const [key, value] of Object.entries(headers)) curlArgs.push("-H", `${key}: ${value}`);
    curlArgs.push("-H", "User-Agent: Mozilla/5.0 AlphaBacktest/1.0", url);
    try {
      return execFileSync("curl", curlArgs, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    } catch (curlError) {
      throw new Error(`fetch failed: ${fetchError.message}; curl failed: ${curlError.message}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function tencentVolumeUnit(symbol) {
  if (symbol.startsWith("sz")) return 100;
  if (symbol.startsWith("bj")) return 100;
  return 1;
}

function parseTencentPayload(json, symbol) {
  const node = json?.data?.[symbol];
  const rows = node?.qfqday || node?.day || [];
  return rows
    .filter((row) => Array.isArray(row) && row.length >= 6)
    .map((row) => {
      const open = Number(row[1]);
      const close = Number(row[2]);
      const high = Number(row[3]);
      const low = Number(row[4]);
      const rawVolume = Number(row[5]);
      const volumeUnit = tencentVolumeUnit(symbol);
      return {
        date: row[0],
        open,
        close,
        high,
        low,
        volume: rawVolume * volumeUnit,
      };
    })
    .filter((row) => row.date && Number.isFinite(row.close));
}

const BENCHMARKS = {
  shComposite: { symbol: "sh000001", name: "上证指数" },
  szComponent: { symbol: "sz399001", name: "深证成指" },
  csi300: { symbol: "sh000300", name: "沪深300" },
  csi500: { symbol: "sh000905", name: "中证500" },
  csi1000: { symbol: "sh000852", name: "中证1000" },
  chinext: { symbol: "sz399006", name: "创业板指" },
  star50: { symbol: "sh000688", name: "科创50" },
  bse50: { symbol: "bj899050", name: "北证50", fallback: "csi300" },
  hsi: { symbol: "hkHSI", name: "恒生指数" },
  hscei: { symbol: "hkHSCEI", name: "恒生国企" },
  hstech: { symbol: "hkHSTECH", name: "恒生科技" },
};

const MAIN_INDEX_KEYS = [
  "shComposite",
  "szComponent",
  "csi300",
  "csi500",
  "csi1000",
  "chinext",
  "star50",
  "bse50",
  "hsi",
  "hscei",
  "hstech",
];

function benchmarkDefForRow(row) {
  const market = String(row.market || "");
  if (/港/.test(market)) return BENCHMARKS.hstech;
  if (/创业/.test(market)) return BENCHMARKS.chinext;
  if (/科创/.test(market)) return BENCHMARKS.star50;
  if (/北交|新三板/.test(market)) return BENCHMARKS.bse50;
  return BENCHMARKS.csi300;
}

function benchmarkSymbolsForUniverse(universe) {
  const symbols = new Set();
  for (const row of universe) {
    const def = benchmarkDefForRow(row);
    symbols.add(def.symbol);
    if (def.fallback) symbols.add(BENCHMARKS[def.fallback].symbol);
  }
  for (const key of MAIN_INDEX_KEYS) symbols.add(BENCHMARKS[key].symbol);
  return Array.from(symbols);
}

async function fetchTencentSymbolKline(symbol, opts) {
  const cacheFile = tencentBenchmarkCacheFile(symbol, opts);
  const cached = readCache(cacheFile, opts.refresh);
  if (cached?.kline?.length) return { ...cached, fromCache: true };

  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,${opts.lookback},qfq`;
  const text = await requestText(url, {}, 16000);
  const json = JSON.parse(text);
  const kline = parseTencentPayload(json, symbol);
  if (!kline.length) throw new Error(`empty_benchmark_kline_${symbol}`);

  const payload = { source: "tencent", symbol, url, fetchedAt: new Date().toISOString(), volumeUnitPolicy: TENCENT_VOLUME_UNIT_POLICY, kline };
  writeCache(cacheFile, payload);
  return payload;
}

function tencentBenchmarkCacheFile(symbol, opts) {
  return path.join(opts.cacheDir, "benchmark", `${safeName(symbol)}_${opts.lookback}.json`);
}

async function fetchTencentKline(row, opts) {
  const symbol = marketSymbol(row);
  const cacheFile = tencentKlineCacheFile(row, opts);
  const cached = readCache(cacheFile, opts.refresh);
  if (cached?.kline?.length) return { ...cached, fromCache: true };

  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,${opts.lookback},qfq`;
  const text = await requestText(url, {}, 16000);
  const json = JSON.parse(text);
  const kline = parseTencentPayload(json, symbol);
  if (!kline.length) throw new Error("empty_tencent_kline");

  const payload = { source: "tencent", symbol, url, fetchedAt: new Date().toISOString(), volumeUnitPolicy: TENCENT_VOLUME_UNIT_POLICY, kline };
  writeCache(cacheFile, payload);
  return payload;
}

function tencentKlineCacheFile(row, opts) {
  const symbol = marketSymbol(row);
  return path.join(opts.cacheDir, "tencent", `${symbol}_${opts.lookback}_qfq.json`);
}

function eastmoneySecid(row) {
  const symbol = marketSymbol(row);
  const code = symbol.slice(2);
  if (symbol.startsWith("sh")) return `1.${code}`;
  if (symbol.startsWith("hk")) return `116.${code}`;
  return `0.${code}`;
}

function parseEastmoneyPayload(json) {
  const rows = json?.data?.klines || [];
  return rows
    .map((line) => String(line).split(","))
    .filter((cells) => cells.length >= 7)
    .map((cells) => {
      const close = Number(cells[2]);
      const amount = Number(cells[6]);
      return {
        date: cells[0],
        open: Number(cells[1]),
        close,
        high: Number(cells[3]),
        low: Number(cells[4]),
        volume: close > 0 && Number.isFinite(amount) ? amount / close : Number(cells[5]) * 100,
        amount,
        pctChg: Number(cells[8]),
        turnoverRate: Number(cells[10]),
      };
    })
    .filter((row) => row.date && Number.isFinite(row.close));
}

async function fetchEastmoneyKline(row, opts) {
  const secid = eastmoneySecid(row);
  const cacheFile = eastmoneyKlineCacheFile(row, opts);
  const cached = readCache(cacheFile, opts.refresh);
  if (cached?.kline?.length) return { ...cached, fromCache: true };

  const fields1 = "f1,f2,f3,f4,f5,f6";
  const fields2 = "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61";
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=${fields1}&fields2=${fields2}&klt=101&fqt=1&beg=${opts.beg}&end=${opts.end}`;
  const text = await requestText(url, { Referer: "https://quote.eastmoney.com/" }, 22000);
  const json = JSON.parse(text);
  const kline = parseEastmoneyPayload(json);
  if (!kline.length) throw new Error("empty_eastmoney_kline");

  const payload = { source: "eastmoney", secid, url, fetchedAt: new Date().toISOString(), kline };
  writeCache(cacheFile, payload);
  return payload;
}

function eastmoneyKlineCacheFile(row, opts) {
  const secid = eastmoneySecid(row);
  return path.join(opts.cacheDir, "eastmoney", `${safeName(secid)}_${opts.beg}_${opts.end}_qfq.json`);
}

function coversRequiredWindow(kline, minAsOf, maxEnd, minHistoryDays) {
  const sorted = kline.slice().sort((a, b) => a.date.localeCompare(b.date));
  const historyDays = sorted.filter((row) => row.date <= minAsOf).length;
  const last = sorted.at(-1)?.date;
  return historyDays >= minHistoryDays && last >= maxEnd;
}

function loadOfflineKlinePayload(symbol, opts) {
  if (!opts.offlineData && !opts.offlineOnly) return null;
  return loadOfflineKlineForSymbol(symbol, opts.offlineDirs || opts);
}

async function loadKline(row, opts) {
  const attempts = [];
  const providers = opts.provider === "auto" ? ["tencent", "eastmoney"] : [opts.provider];
  const symbol = marketSymbol(row);
  const offlinePayload = loadOfflineKlinePayload(symbol, opts);
  if (offlinePayload?.kline?.length) {
    if (coversRequiredWindow(offlinePayload.kline, opts.minAsOf, opts.maxEnd, opts.minHistoryDays)) {
      return {
        ok: true,
        code: row.code,
        name: row.name,
        kline: offlinePayload.kline,
        source: offlinePayload.source,
        fromCache: true,
        offline: true,
        attempts,
      };
    }
    attempts.push("offline:insufficient_window");
  } else if (opts.offlineData || opts.offlineOnly) {
    attempts.push("offline:dataset_miss");
  }
  if (opts.cacheOnly) {
    for (const provider of providers) {
      const cacheFile = provider === "tencent" ? tencentKlineCacheFile(row, opts) : eastmoneyKlineCacheFile(row, opts);
      const payload = readCache(cacheFile, false);
      if (!payload?.kline?.length) {
        attempts.push(`${provider}:cache_miss`);
        continue;
      }
      if (!coversRequiredWindow(payload.kline, opts.minAsOf, opts.maxEnd, opts.minHistoryDays)) {
        attempts.push(`${provider}:insufficient_window`);
        continue;
      }
      return {
        ok: true,
        code: row.code,
        name: row.name,
        kline: payload.kline,
        source: payload.source || provider,
        fromCache: true,
        attempts,
      };
    }
    return { ok: false, code: row.code, name: row.name, attempts };
  }
  for (const provider of providers) {
    try {
      const payload = provider === "tencent"
        ? await fetchTencentKline(row, opts)
        : await fetchEastmoneyKline(row, opts);
      if (!coversRequiredWindow(payload.kline, opts.minAsOf, opts.maxEnd, opts.minHistoryDays)) {
        attempts.push(`${provider}:insufficient_window`);
        continue;
      }
      return {
        ok: true,
        code: row.code,
        name: row.name,
        kline: payload.kline,
        source: payload.source,
        fromCache: Boolean(payload.fromCache),
        attempts,
      };
    } catch (error) {
      attempts.push(`${provider}:${error.message}`);
    }
  }
  return { ok: false, code: row.code, name: row.name, attempts };
}

async function loadBenchmarkKlines(universe, opts) {
  const symbols = benchmarkSymbolsForUniverse(universe);
  const out = new Map();
  const failures = [];
  await mapLimit(symbols, Math.min(4, symbols.length), async (symbol) => {
    try {
      let payload = null;
      const offlinePayload = loadOfflineKlinePayload(symbol, opts);
      if (offlinePayload?.kline?.length && coversRequiredWindow(offlinePayload.kline, opts.minAsOf, opts.maxEnd, 2)) {
        out.set(symbol, offlinePayload.kline);
        return;
      }
      if (opts.cacheOnly) {
        payload = readCache(tencentBenchmarkCacheFile(symbol, opts), false);
        if (!payload?.kline?.length) {
          failures.push({ symbol, reason: "cache_miss" });
          return;
        }
      } else {
        payload = await fetchTencentSymbolKline(symbol, opts);
      }
      if (!coversRequiredWindow(payload.kline, opts.minAsOf, opts.maxEnd, 2)) {
        failures.push({ symbol, reason: "insufficient_window" });
        return;
      }
      out.set(symbol, payload.kline);
    } catch (error) {
      failures.push({ symbol, reason: error.message });
    }
  });
  return { benchmarkKlineBySymbol: out, benchmarkFailures: failures };
}

function periodBenchmarkForDef(def, period, benchmarkKlineBySymbol) {
  const candidates = [def, def.fallback ? BENCHMARKS[def.fallback] : null].filter(Boolean);
  for (const candidate of candidates) {
    const kline = benchmarkKlineBySymbol.get(candidate.symbol);
    if (!kline) continue;
    const ret = benchmarkReturn(kline, period.asOf, period.end);
    if (Number.isFinite(ret)) return { ...candidate, return: ret };
  }
  return { ...def, return: null };
}

function buildBenchmarkMaps(universe, periods, benchmarkKlineBySymbol) {
  const byPeriod = new Map();
  const summaryRows = [];
  for (const period of periods) {
    const key = `${period.asOf}:${period.end}`;
    const returnByCode = new Map();
    const counts = new Map();
    const returnsBySymbol = new Map();
    for (const row of universe) {
      const def = benchmarkDefForRow(row);
      const selected = periodBenchmarkForDef(def, period, benchmarkKlineBySymbol);
      returnByCode.set(row.code, selected.return);
      const stat = counts.get(selected.symbol) || { symbol: selected.symbol, name: selected.name, count: 0, return: selected.return };
      stat.count += 1;
      counts.set(selected.symbol, stat);
      returnsBySymbol.set(selected.symbol, selected.return);
    }
    byPeriod.set(key, returnByCode);
    for (const stat of counts.values()) {
      summaryRows.push({
        period: key,
        symbol: stat.symbol,
        name: stat.name,
        universeCount: stat.count,
        benchmarkReturn: round(stat.return, 6),
      });
    }
  }
  return { byPeriod, summaryRows };
}

function buildBenchmarkMapsForPeriodUniverses(periods, periodUniverseRowsByKey, benchmarkKlineBySymbol) {
  const byPeriod = new Map();
  const summaryRows = [];
  for (const period of periods) {
    const key = periodKey(period);
    const universe = periodUniverseRowsByKey.get(key) || [];
    const returnByCode = new Map();
    const counts = new Map();
    for (const row of universe) {
      const def = benchmarkDefForRow(row);
      const selected = periodBenchmarkForDef(def, period, benchmarkKlineBySymbol);
      returnByCode.set(row.code, selected.return);
      const stat = counts.get(selected.symbol) || { symbol: selected.symbol, name: selected.name, count: 0, return: selected.return };
      stat.count += 1;
      counts.set(selected.symbol, stat);
    }
    byPeriod.set(key, returnByCode);
    for (const stat of counts.values()) {
      summaryRows.push({
        period: key,
        symbol: stat.symbol,
        name: stat.name,
        universeCount: stat.count,
        benchmarkReturn: round(stat.return, 6),
      });
    }
  }
  return { byPeriod, summaryRows };
}

function buildBenchmarkKlineByCode(universe, benchmarkKlineBySymbol) {
  const out = new Map();
  for (const row of universe) {
    const def = benchmarkDefForRow(row);
    const candidates = [def, def.fallback ? BENCHMARKS[def.fallback] : null].filter(Boolean);
    const selected = candidates.find((candidate) => benchmarkKlineBySymbol.has(candidate.symbol));
    if (selected) out.set(row.code, benchmarkKlineBySymbol.get(selected.symbol));
  }
  return out;
}

function buildMainIndexSummaryRows(periods, benchmarkKlineBySymbol) {
  const rows = [];
  for (const period of periods) {
    const key = `${period.asOf}:${period.end}`;
    for (const indexKey of MAIN_INDEX_KEYS) {
      const def = BENCHMARKS[indexKey];
      const kline = benchmarkKlineBySymbol.get(def.symbol);
      rows.push({
        period: key,
        symbol: def.symbol,
        name: def.name,
        indexKey,
        return: kline ? round(benchmarkReturn(kline, period.asOf, period.end), 6) : "",
      });
    }
  }
  return rows;
}

async function mapLimit(items, limit, fn, onProgress) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let done = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(items[index], index);
      done += 1;
      if (onProgress) onProgress(done, items.length, results[index]);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

function paramsForRun(args) {
  let base = args.optimize ? paramGrid() : [defaultParams()];
  if (!args.paramNames?.length && !args.includeExperimentalParams) {
    base = base.filter((params) => !params.experimental);
  }
  const withoutStaticTheme = (params) => ({
    ...params,
    name: `${params.name}_no_static_theme`,
    staticThemeScore: false,
    staticIndustryMomentum: false,
    themeWeight: 0,
    rankThemeWeight: 0,
    rankIndustryWeight: 0,
  });
  const selectiveNoStaticNames = new Set(args.noStaticParamNames || []);
  if ((args.includeNoStaticParams || selectiveNoStaticNames.size) && !args.noStaticTheme) {
    if (selectiveNoStaticNames.size) {
      const availableSourceNames = new Set(base.map((params) => params.name));
      const missingSources = [...selectiveNoStaticNames].filter((name) => !availableSourceNames.has(name));
      if (missingSources.length) {
        throw new Error(`Unknown --include-no-static-param-names: ${missingSources.join(", ")}`);
      }
    }
    const cloneSource = args.includeNoStaticParams
      ? base
      : base.filter((params) => selectiveNoStaticNames.has(params.name));
    base = base.concat(cloneSource.map(withoutStaticTheme));
  }
  if (args.paramNames?.length) {
    const requestedParamNames = new Set(args.paramNames);
    base = base.filter((params) => {
      if (requestedParamNames.has(params.name)) return true;
      const noStaticSourceName = params.name.endsWith("_no_static_theme")
        ? params.name.replace(/_no_static_theme$/, "")
        : null;
      if (noStaticSourceName && selectiveNoStaticNames.has(noStaticSourceName) && requestedParamNames.has(noStaticSourceName)) {
        return true;
      }
      if (args.noStaticTheme && params.name.endsWith("_no_static_theme")) {
        return requestedParamNames.has(params.name.replace(/_no_static_theme$/, ""));
      }
      return false;
    });
    const availableParamNames = new Set(base.map((params) => params.name.replace(/_no_static_theme$/, "")));
    const missing = args.paramNames.filter((name) => !availableParamNames.has(name) && !base.some((params) => params.name === name));
    if (missing.length) throw new Error(`Unknown --param-names: ${missing.join(", ")}`);
  }
  const executionCost = {
    enabled: Boolean(args.costs),
    roundTripBps: args.costBps,
    indexRoundTripBps: args.indexCostBps,
  };
  const tradability = {
    enabled: Boolean(args.tradability),
    minTurnover: args.minEntryTurnover,
    maxExitDelayDays: args.maxExitDelayDays,
  };
  const universeFilter = {
    enabled: Boolean(args.universeFilter),
    minAvgTurnover20: args.minUniverseTurnover,
    minPriceAsOf: args.minUniversePrice,
    maxVol20: args.maxUniverseVol,
    excludeST: args.excludeSTUniverse,
    dynamicGroup: {
      enabled: Boolean(args.dynamicGroupFilter),
      groupBy: args.dynamicGroupBy,
      minGroupSize: args.minDynamicGroupSize,
      minGroupScore: args.minDynamicGroupScore,
      minBreadth20: args.minDynamicGroupBreadth,
    },
  };
  const topValues = args.topValues?.length ? args.topValues : [args.top];
  const shouldSuffixTopN = Boolean(args.topValues?.length);
  return base.flatMap((params) => {
    const staticAdjusted = args.noStaticTheme ? withoutStaticTheme(params) : params;
    return topValues.map((topN) => ({
      ...staticAdjusted,
      name: shouldSuffixTopN ? `${staticAdjusted.name}_top${topN}` : staticAdjusted.name,
      baseParamName: staticAdjusted.name,
      topNOverride: topN,
      minHistoryDays: args.minHistory,
      executionCost: {
        ...executionCost,
        ...(staticAdjusted.executionCost || {}),
      },
      tradability: {
        ...tradability,
        ...(staticAdjusted.tradability || {}),
      },
      universeFilter: {
        ...universeFilter,
        ...(staticAdjusted.universeFilter || {}),
        dynamicGroup: {
          ...universeFilter.dynamicGroup,
          minRemainingCount: args.minDynamicGroupRemaining > 0 ? args.minDynamicGroupRemaining : topN,
          ...(staticAdjusted.universeFilter?.dynamicGroup || {}),
        },
      },
    }));
  });
}

function baseRunParamName(name) {
  return String(name || "").replace(/_top\d+$/, "");
}

function walkForwardOptionsForRun(args, params, periods) {
  const options = {
    minTrainPeriods: Math.min(3, Math.max(1, periods.length - 1)),
  };
  if (args.walkForwardStableParam) {
    const stableParamExists = params.some((paramsItem) => (
      paramsItem.name === args.walkForwardStableParam ||
      paramsItem.baseParamName === args.walkForwardStableParam ||
      baseRunParamName(paramsItem.name) === args.walkForwardStableParam
    ));
    if (!stableParamExists) {
      throw new Error(`Unknown --wf-stable-param: ${args.walkForwardStableParam}`);
    }
    options.stableParamName = args.walkForwardStableParam;
  }
  if (args.walkForwardSwitchMargin > 0) {
    options.switchMargin = args.walkForwardSwitchMargin;
  }
  if (args.walkForwardIncumbentPolicy) {
    options.incumbentPolicy = args.walkForwardIncumbentPolicy;
  }
  if (args.walkForwardCurrentGate && args.walkForwardCurrentGate !== "off") {
    options.currentBasketGate = args.walkForwardCurrentGate;
  }
  if (args.walkForwardMinExploratoryPeriods > 0) {
    options.exploratoryMinTrainPeriods = args.walkForwardMinExploratoryPeriods;
  }
  if (args.walkForwardKnownOutcomeOnly) {
    options.knownOutcomeOnly = true;
  }
  return options;
}

function summarizePeriodResult(result, paramName) {
  const t = result.welchTopVsRest || {};
  return {
    param: paramName,
    topN: result.topN,
    period: `${result.asOf}:${result.end}`,
    asOf: result.asOf,
    end: result.end,
    scoredCount: result.scoredCount,
    skippedCount: result.skippedCount,
    topMeanReturn: round(result.topMeanReturn, 6),
    netTopMeanReturn: round(result.netTopMeanReturn, 6),
    weightedTopReturn: round(result.weightedTopReturn, 6),
    netWeightedTopReturn: round(result.netWeightedTopReturn, 6),
    adaptiveWeightedTopReturn: round(result.adaptiveWeightedTopReturn, 6),
    netAdaptiveWeightedTopReturn: round(result.netAdaptiveWeightedTopReturn, 6),
    benchmarkOverlayWeight: round(result.benchmarkOverlayWeight, 6),
    defensiveCashWeight: round(result.defensiveCashWeight, 6),
    weakMarketCashWeight: round(result.weakMarketCashWeight, 6),
    exhaustionCashWeight: round(result.exhaustionCashWeight, 6),
    universeMeanReturn: round(result.universeMeanReturn, 6),
    netUniverseMeanReturn: round(result.netUniverseMeanReturn, 6),
    benchmarkReturn: round(result.benchmarkReturn, 6),
    netBenchmarkReturn: round(result.netBenchmarkReturn, 6),
    topBenchmarkReturn: round(result.topBenchmarkReturn, 6),
    netTopBenchmarkReturn: round(result.netTopBenchmarkReturn, 6),
    weightedBenchmarkReturn: round(result.weightedBenchmarkReturn, 6),
    netWeightedBenchmarkReturn: round(result.netWeightedBenchmarkReturn, 6),
    restMeanReturn: round(result.restMeanReturn, 6),
    netRestMeanReturn: round(result.netRestMeanReturn, 6),
    excessReturn: round(result.excessReturn, 6),
    netExcessReturn: round(result.netExcessReturn, 6),
    weightedExcessReturn: round(result.weightedExcessReturn, 6),
    netWeightedExcessReturn: round(result.netWeightedExcessReturn, 6),
    adaptiveWeightedExcessReturn: round(result.adaptiveWeightedExcessReturn, 6),
    netAdaptiveWeightedExcessReturn: round(result.netAdaptiveWeightedExcessReturn, 6),
    topExcessVsBenchmark: round(result.topExcessVsBenchmark, 6),
    netTopExcessVsBenchmark: round(result.netTopExcessVsBenchmark, 6),
    weightedExcessVsBenchmark: round(result.weightedExcessVsBenchmark, 6),
    netWeightedExcessVsBenchmark: round(result.netWeightedExcessVsBenchmark, 6),
    adaptiveExcessVsBenchmark: round(result.adaptiveExcessVsBenchmark, 6),
    netAdaptiveExcessVsBenchmark: round(result.netAdaptiveExcessVsBenchmark, 6),
    universeExcessVsBenchmark: round(result.universeExcessVsBenchmark, 6),
    netUniverseExcessVsBenchmark: round(result.netUniverseExcessVsBenchmark, 6),
    topWinRate: round(result.topWinRate, 6),
    netTopWinRate: round(result.netTopWinRate, 6),
    universeWinRate: round(result.universeWinRate, 6),
    netUniverseWinRate: round(result.netUniverseWinRate, 6),
    welchT: round(t.t, 4),
    pValue: round(t.pValue, 6),
    significant5pct: Number.isFinite(t.pValue) ? t.pValue < 0.05 : false,
  };
}

function csvRowsForScored(scored) {
  return scored.map((row, index) => ({
    rank: index + 1,
    code: row.code,
    name: row.name,
    market: row.market || "",
    industry: row.industry || "",
    universeSource: row.universeSource || "",
    score: row.score,
    rawScore: round(row.rawScore, 4),
    crossSectionScore: round(row.crossSectionScore, 4),
    recommendedWeight: round(row.recommendedWeight, 6),
    recommendedWeightPct: round(row.recommendedWeightPct, 4),
    forwardReturn: round(row.forwardReturn, 6),
    executionCostRate: round(row.executionCostRate, 6),
    netForwardReturn: round(row.netForwardReturn, 6),
    benchmarkForwardReturn: round(row.benchmarkForwardReturn, 6),
    benchmarkExecutionCostRate: round(row.benchmarkExecutionCostRate, 6),
    netBenchmarkForwardReturn: round(row.netBenchmarkForwardReturn, 6),
    excessVsBenchmark: Number.isFinite(row.forwardReturn) && Number.isFinite(row.benchmarkForwardReturn)
      ? round(row.forwardReturn - row.benchmarkForwardReturn, 6)
      : "",
    netExcessVsBenchmark: Number.isFinite(row.netForwardReturn) && Number.isFinite(row.netBenchmarkForwardReturn)
      ? round(row.netForwardReturn - row.netBenchmarkForwardReturn, 6)
      : "",
    priceAsOf: row.priceAsOf,
    entryDayReturn: round(row.entryDayReturn, 6),
    entryTurnover: round(row.entryTurnover, 2),
    entryCloseAtHigh: row.entryCloseAtHigh,
    entryDate: row.entryDate || "",
    targetExitDate: row.targetExitDate || "",
    exitDate: row.exitDate || "",
    exitDelayDays: row.exitDelayDays ?? "",
    exitReason: row.exitReason || "",
    exitDayReturn: round(row.exitDayReturn, 6),
    exitTurnover: round(row.exitTurnover, 2),
    exitCloseAtLow: row.exitCloseAtLow,
    r5: round(row.r5, 6),
    r20: round(row.r20, 6),
    r60: round(row.r60, 6),
    acceleration20vs60: round(row.acceleration20vs60, 6),
    dd60: round(row.dd60, 6),
    vol20: round(row.vol20, 6),
    avgTurnover20: round(row.avgTurnover20, 2),
    pullbackAccumulationScore: round(row.pullbackAccumulationScore, 4),
    pullbackDrawdown20: round(row.pullbackDrawdown20, 6),
    pullbackSupportRatio20: round(row.pullbackSupportRatio20, 6),
    pullbackVolumeRatio5v20: round(row.pullbackVolumeRatio5v20, 6),
    volumeMomentumScore: round(row.volumeMomentumScore, 4),
    volumeTurnoverRatio5v20: round(row.volumeTurnoverRatio5v20, 6),
    shortTermReversalScore: round(row.shortTermReversalScore, 4),
    shortTermReversalR3: round(row.shortTermReversalR3, 6),
    shortTermDrawdown20: round(row.shortTermDrawdown20, 6),
    shortTermSupportRatio20: round(row.shortTermSupportRatio20, 6),
    turnoverCv20: round(row.turnoverCv20, 6),
    turnoverStabilityScore: round(row.turnoverStabilityScore, 4),
    freshTrendScore: round(row.freshTrendScore, 4),
    freshAccelerationScore: round(row.freshAccelerationScore, 4),
    trendMaturityPenaltyScore: round(row.trendMaturityPenaltyScore, 4),
    high52wScore: round(row.high52wScore, 4),
    high52wDistance: round(row.high52wDistance, 6),
    high52wDaysSinceHigh: row.high52wDaysSinceHigh ?? "",
    maxDailyReturn20: round(row.maxDailyReturn20, 6),
    maxPositiveShare20: round(row.maxPositiveShare20, 6),
    lotterySpikeScore: round(row.lotterySpikeScore, 4),
    momentumScore: round(row.momentumScore, 4),
    liquidityScore: round(row.liquidityScore, 4),
    stabilityScore: round(row.stabilityScore, 4),
    themeScore: round(row.themeScore, 4),
    benchmarkR5: round(row.benchmarkR5, 6),
    benchmarkR20: round(row.benchmarkR20, 6),
    benchmarkR60: round(row.benchmarkR60, 6),
    relativeR5: round(row.relativeR5, 6),
    relativeR20: round(row.relativeR20, 6),
    relativeR60: round(row.relativeR60, 6),
    relativeMomentumScore: round(row.relativeMomentumScore, 4),
    industryCount: row.industryCount || "",
    industryR20: round(row.industryR20, 6),
    industryR60: round(row.industryR60, 6),
    industryRelativeR20: round(row.industryRelativeR20, 6),
    industryRelativeR60: round(row.industryRelativeR60, 6),
    industryBreadth20: round(row.industryBreadth20, 6),
    industryMomentumScore: round(row.industryMomentumScore, 4),
    industryResidualR20: round(row.industryResidualR20, 6),
    industryResidualR60: round(row.industryResidualR60, 6),
    industryResidualRelativeR20: round(row.industryResidualRelativeR20, 6),
    industryResidualRelativeR60: round(row.industryResidualRelativeR60, 6),
    industryResidualMomentumScore: round(row.industryResidualMomentumScore, 4),
    dynamicGroupKey: row.dynamicGroupKey || "",
    dynamicGroupCount: row.dynamicGroupCount || "",
    dynamicGroupR20: round(row.dynamicGroupR20, 6),
    dynamicGroupR60: round(row.dynamicGroupR60, 6),
    dynamicGroupRelativeR20: round(row.dynamicGroupRelativeR20, 6),
    dynamicGroupRelativeR60: round(row.dynamicGroupRelativeR60, 6),
    dynamicGroupBreadth20: round(row.dynamicGroupBreadth20, 6),
    dynamicGroupScore: round(row.dynamicGroupScore, 4),
    scoreBeforeDynamicGroupBlend: round(row.scoreBeforeDynamicGroupBlend, 4),
    dynamicGroupScoreBlendWeight: round(row.dynamicGroupScoreBlendWeight, 4),
    dynamicGroupRankScore: round(row.dynamicGroupRankScore, 4),
    trendRankScore: round(row.trendRankScore, 4),
    accelerationRankScore: round(row.accelerationRankScore, 4),
    riskRankScore: round(row.riskRankScore, 4),
    liquidityRankScore: round(row.liquidityRankScore, 4),
    themeRankScore: round(row.themeRankScore, 4),
    relativeRankScore: round(row.relativeRankScore, 4),
    relativeMomentumRankScore: round(row.relativeMomentumRankScore, 4),
    benchmarkTrendRankScore: round(row.benchmarkTrendRankScore, 4),
    industryRankScore: round(row.industryRankScore, 4),
    industryResidualRankScore: round(row.industryResidualRankScore, 4),
    pullbackRankScore: round(row.pullbackRankScore, 4),
    volumeMomentumRankScore: round(row.volumeMomentumRankScore, 4),
    shortTermReversalRankScore: round(row.shortTermReversalRankScore, 4),
    turnoverStabilityRankScore: round(row.turnoverStabilityRankScore, 4),
    freshTrendRankScore: round(row.freshTrendRankScore, 4),
    lotterySpikeRankScore: round(row.lotterySpikeRankScore, 4),
    high52wRankScore: round(row.high52wRankScore, 4),
    consistencyRankScore: round(row.consistencyRankScore, 4),
    overheatPenaltyScore: round(row.overheatPenaltyScore, 4),
  }));
}

function csvRowsForUniverseFieldAudit(audit) {
  return (audit?.fields || []).map((field) => ({
    field: field.field,
    classification: field.classification,
    riskLevel: field.riskLevel,
    pointInTimeStatus: field.pointInTimeStatus,
    usedByScoring: field.usedByScoring,
    requiresPointInTime: field.requiresPointInTime,
    scoringAction: field.scoringAction,
    nonEmptyCount: field.nonEmptyCount,
    exampleValues: field.exampleValues,
  }));
}

const POOL_SELECTOR_PREFERRED_HEADERS = [
  "periodIndex",
  "period",
  "asOf",
  "end",
  "selectedPool",
  "selectedPoolParam",
  "poolSelectionReason",
  "candidatePool",
  "candidatePoolTrainingScore",
  "incumbentPool",
  "incumbentPoolTrainingScore",
  "poolScoreAdvantage",
  "featureGateMode",
  "featureGateReason",
  "featureGatePrimaryPool",
  "featureGateBaselinePool",
  "featureGateRelativeMomentumAdvantage",
  "featureGateRelativeR20Advantage",
  "featureGateRelativeR60Advantage",
  "featureGateBenchmarkR20Advantage",
  "featureGateVolumeMomentumAdvantage",
  "featureGateVolumeTurnoverAdvantage",
  "featureGateTurnoverStabilityAdvantage",
  "featureGateEntryDayReturnAdvantage",
  "featureGateThresholdName",
  "featureGateMomentumThreshold",
  "featureGateR20Threshold",
  "featureGateR60Threshold",
  "featureGateBenchmarkR20Threshold",
  "featureGateVolumeMomentumThreshold",
  "featureGateTurnoverStabilityThreshold",
  "featureGateTrainingPhysicalSelections",
  "featureGateTrainingAvgReturnDelta",
  "featureGateTrainingHitCount",
  "boardGateMode",
  "boardGatePassed",
  "boardGateReason",
  "boardGateSelectedPool",
  "boardGateBlockedPool",
  "boardGateFallbackPool",
  "boardGateBaselinePool",
  "boardGateFreshTrendAdvantage",
  "boardGateVolumeMomentumAdvantage",
  "boardGateLotterySpikeAdvantage",
  "boardGateTurnoverStabilityAdvantage",
  "boardGateRelativeMomentumAdvantage",
  "boardGateRelativeR20Advantage",
  "boardGateEntryDayReturnAdvantage",
  "riskGateMode",
  "riskGatePassed",
  "riskGateReason",
  "riskGateSelectedPool",
  "riskGateBlockedPool",
  "riskGateBaselinePool",
  "riskGateR60Advantage",
  "riskGateRelativeR60Advantage",
  "riskGateBenchmarkR60Advantage",
  "riskGateFreshTrendAdvantage",
  "riskGateLotterySpikeAdvantage",
  "riskGateTurnoverStabilityAdvantage",
  "eligiblePoolCount",
  "trainingScore",
  "trainingAvgReturn",
  "trainingAvgExcess",
  "trainingPeriods",
  "trainingLookbackPeriods",
  "trainingReturnVol",
  "trainingExcessVol",
  "trainingWorstReturn",
  "trainingWorstExcess",
  "netAdaptiveWeightedTopReturn",
  "netAdaptiveExcessVsBenchmark",
  "netAdaptiveWeightedExcessReturn",
  "weightedTopReturn",
  "netWeightedTopReturn",
  "topMeanReturn",
  "netTopMeanReturn",
  "netUniverseMeanReturn",
  "netWeightedBenchmarkReturn",
  "benchmarkOverlayWeight",
  "defensiveCashWeight",
  "pValue",
  "selectedParam",
  "selectedTopN",
];

function headersForRows(rows, preferredHeaders = []) {
  const headers = [];
  const seen = new Set();
  const add = (header) => {
    if (!header || seen.has(header)) return;
    seen.add(header);
    headers.push(header);
  };
  for (const header of preferredHeaders) add(header);
  for (const row of rows) {
    for (const header of Object.keys(row || {})) add(header);
  }
  return headers;
}

function metricValues(rows, field) {
  return rows.map((row) => Number(row[field])).filter(Number.isFinite);
}

function positiveCount(rows, field) {
  return metricValues(rows, field).filter((value) => value > 0).length;
}

function sampleStddev(values) {
  const xs = values.filter(Number.isFinite);
  if (xs.length < 2) return null;
  const avg = mean(xs);
  const variance = xs.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

function summarizePoolSelectorRows(rows) {
  const netAdaptive = metricValues(rows, "netAdaptiveWeightedTopReturn");
  const benchmarkExcess = metricValues(rows, "netAdaptiveExcessVsBenchmark");
  const universeExcess = metricValues(rows, "netAdaptiveWeightedExcessReturn");
  const hitCountVsBenchmark = positiveCount(rows, "netAdaptiveExcessVsBenchmark");
  const hitCountVsUniverse = positiveCount(rows, "netAdaptiveWeightedExcessReturn");
  const selectedPoolCounts = {};
  for (const row of rows) {
    if (!row.selectedPool) continue;
    selectedPoolCounts[row.selectedPool] = (selectedPoolCounts[row.selectedPool] || 0) + 1;
  }
  return {
    rowCount: rows.length,
    avgNetAdaptiveWeightedTopReturn: round(mean(netAdaptive), 6),
    avgNetAdaptiveExcessVsBenchmark: round(mean(benchmarkExcess), 6),
    avgNetAdaptiveWeightedExcessReturn: round(mean(universeExcess), 6),
    hitCountVsBenchmark,
    hitRateVsBenchmark: benchmarkExcess.length ? round(hitCountVsBenchmark / benchmarkExcess.length, 6) : "",
    hitCountVsUniverse,
    hitRateVsUniverse: universeExcess.length ? round(hitCountVsUniverse / universeExcess.length, 6) : "",
    worstNetAdaptiveWeightedTopReturn: netAdaptive.length ? round(Math.min(...netAdaptive), 6) : "",
    bestNetAdaptiveWeightedTopReturn: netAdaptive.length ? round(Math.max(...netAdaptive), 6) : "",
    selectedPoolCounts,
  };
}

function comparePoolSelectorRowsToBaseline(selectedRows, baselineRows, baselinePool) {
  const baselineByPeriod = new Map((baselineRows || []).map((row) => [row.period, row]));
  const pairs = [];
  for (const row of selectedRows || []) {
    const baseline = baselineByPeriod.get(row.period);
    if (!baseline) continue;
    const selectorReturn = Number(row.netAdaptiveWeightedTopReturn);
    const baselineReturn = Number(baseline.netAdaptiveWeightedTopReturn);
    if (!Number.isFinite(selectorReturn) || !Number.isFinite(baselineReturn)) continue;
    pairs.push({
      period: row.period,
      selectorReturn,
      baselineReturn,
      returnDelta: selectorReturn - baselineReturn,
    });
  }
  const selectorReturns = pairs.map((pair) => pair.selectorReturn);
  const baselineReturns = pairs.map((pair) => pair.baselineReturn);
  const deltas = pairs.map((pair) => pair.returnDelta);
  const avgDelta = mean(deltas);
  const hitCount = deltas.filter((value) => value > 0).length;
  const sd = sampleStddev(deltas);
  const pairedT = Number.isFinite(sd) && sd > 0 && deltas.length > 1
    ? avgDelta / (sd / Math.sqrt(deltas.length))
    : null;
  const pairedPValue = Number.isFinite(pairedT)
    ? 2 * (1 - normalCdfApprox(Math.abs(pairedT)))
    : null;
  const latestPair = pairs.at(-1);
  return {
    baselinePool,
    rowCount: pairs.length,
    selectorAvgReturn: round(mean(selectorReturns), 6),
    baselineAvgReturn: round(mean(baselineReturns), 6),
    avgReturnDelta: round(avgDelta, 6),
    hitCountVsBaseline: hitCount,
    hitRateVsBaseline: deltas.length ? round(hitCount / deltas.length, 6) : "",
    worstReturnDelta: deltas.length ? round(Math.min(...deltas), 6) : "",
    bestReturnDelta: deltas.length ? round(Math.max(...deltas), 6) : "",
    latestReturnDelta: latestPair ? round(latestPair.returnDelta, 6) : "",
    pairedReturnTStat: Number.isFinite(pairedT) ? round(pairedT, 6) : "",
    pairedReturnPValueApprox: Number.isFinite(pairedPValue) ? round(pairedPValue, 6) : "",
  };
}

function readWalkForwardRowsForPool(pool) {
  const file = path.join(pool.dir, "walk_forward_summary.csv");
  if (!fs.existsSync(file)) {
    throw new Error(`Missing walk_forward_summary.csv for pool ${pool.name}: ${file}`);
  }
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  if (!rows.length) {
    throw new Error(`Empty walk_forward_summary.csv for pool ${pool.name}: ${file}`);
  }
  return rows;
}

function topRowsFileCandidates(poolDir, periodRow) {
  const selectedTopN = Number(periodRow.selectedTopN);
  const [asOf, end] = String(periodRow.period || `${periodRow.asOf}:${periodRow.end}`).split(":");
  const values = [selectedTopN, 10, 8, 12, 15, 5].filter((value) => Number.isInteger(value) && value > 0);
  const seen = new Set();
  return values
    .filter((value) => {
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    })
    .flatMap((value) => [
      path.join(poolDir, `walk_forward_top${value}_${asOf}_${end}.csv`),
      path.join(poolDir, `top${value}_${asOf}_${end}.csv`),
    ]);
}

function readTopRowsForPoolPeriod(poolDir, poolName, periodRow) {
  const candidates = topRowsFileCandidates(poolDir, periodRow);
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file) {
    throw new Error(`Missing TopN CSV for pool ${poolName} period ${periodRow.period}: ${candidates.join(", ")}`);
  }
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  if (!rows.length) {
    throw new Error(`Empty TopN CSV for pool ${poolName} period ${periodRow.period}: ${file}`);
  }
  return rows;
}

function topRowsFeatureMean(rows, field) {
  return mean(rows.map((row) => Number(row[field])).filter(Number.isFinite));
}

function topRowsFeatureSummary(rows) {
  return {
    relativeMomentumScore: topRowsFeatureMean(rows, "relativeMomentumScore"),
    relativeR20: topRowsFeatureMean(rows, "relativeR20"),
    relativeR60: topRowsFeatureMean(rows, "relativeR60"),
    r60: topRowsFeatureMean(rows, "r60"),
    benchmarkR20: topRowsFeatureMean(rows, "benchmarkR20"),
    benchmarkR60: topRowsFeatureMean(rows, "benchmarkR60"),
    freshTrendScore: topRowsFeatureMean(rows, "freshTrendScore"),
    lotterySpikeScore: topRowsFeatureMean(rows, "lotterySpikeScore"),
    volumeMomentumScore: topRowsFeatureMean(rows, "volumeMomentumScore"),
    volumeTurnoverRatio5v20: topRowsFeatureMean(rows, "volumeTurnoverRatio5v20"),
    turnoverStabilityScore: topRowsFeatureMean(rows, "turnoverStabilityScore"),
    entryDayReturn: topRowsFeatureMean(rows, "entryDayReturn"),
  };
}

function featureDelta(candidateValue, baselineValue) {
  return Number.isFinite(candidateValue) && Number.isFinite(baselineValue)
    ? candidateValue - baselineValue
    : null;
}

function physicalRelativeFeatureAdvantage(primaryTop, baselineTop) {
  return {
    relativeMomentumAdvantage: primaryTop.relativeMomentumScore - baselineTop.relativeMomentumScore,
    relativeR20Advantage: primaryTop.relativeR20 - baselineTop.relativeR20,
    relativeR60Advantage: primaryTop.r60 - baselineTop.r60,
    benchmarkR20Advantage: primaryTop.benchmarkR20 - baselineTop.benchmarkR20,
    volumeMomentumAdvantage: primaryTop.volumeMomentumScore - baselineTop.volumeMomentumScore,
    volumeTurnoverAdvantage: primaryTop.volumeTurnoverRatio5v20 - baselineTop.volumeTurnoverRatio5v20,
    turnoverStabilityAdvantage: primaryTop.turnoverStabilityScore - baselineTop.turnoverStabilityScore,
    entryDayReturnAdvantage: primaryTop.entryDayReturn - baselineTop.entryDayReturn,
  };
}

function poolCurrentRiskFeatureAdvantage(candidateTop, baselineTop) {
  return {
    r60Advantage: featureDelta(candidateTop.r60, baselineTop.r60),
    relativeR60Advantage: featureDelta(candidateTop.relativeR60, baselineTop.relativeR60),
    benchmarkR60Advantage: featureDelta(candidateTop.benchmarkR60, baselineTop.benchmarkR60),
    freshTrendAdvantage: featureDelta(candidateTop.freshTrendScore, baselineTop.freshTrendScore),
    lotterySpikeAdvantage: featureDelta(candidateTop.lotterySpikeScore, baselineTop.lotterySpikeScore),
    turnoverStabilityAdvantage: featureDelta(candidateTop.turnoverStabilityScore, baselineTop.turnoverStabilityScore),
  };
}

function poolCurrentBoardFeatureAdvantage(candidateTop, baselineTop) {
  return {
    freshTrendAdvantage: featureDelta(candidateTop.freshTrendScore, baselineTop.freshTrendScore),
    volumeMomentumAdvantage: featureDelta(candidateTop.volumeMomentumScore, baselineTop.volumeMomentumScore),
    lotterySpikeAdvantage: featureDelta(candidateTop.lotterySpikeScore, baselineTop.lotterySpikeScore),
    turnoverStabilityAdvantage: featureDelta(candidateTop.turnoverStabilityScore, baselineTop.turnoverStabilityScore),
    relativeMomentumAdvantage: featureDelta(candidateTop.relativeMomentumScore, baselineTop.relativeMomentumScore),
    relativeR20Advantage: featureDelta(candidateTop.relativeR20, baselineTop.relativeR20),
    entryDayReturnAdvantage: featureDelta(candidateTop.entryDayReturn, baselineTop.entryDayReturn),
  };
}

function poolBoardConfirmationDecision(advantage) {
  const checks = [
    ["fresh", advantage.freshTrendAdvantage, (value) => value >= 20],
    ["volume", advantage.volumeMomentumAdvantage, (value) => value >= 15],
    ["lottery", advantage.lotterySpikeAdvantage, (value) => value <= -8],
    ["turnover", advantage.turnoverStabilityAdvantage, (value) => value >= -10],
    ["relative_momentum", advantage.relativeMomentumAdvantage, (value) => value >= 5],
    ["relative_r20", advantage.relativeR20Advantage, (value) => value >= 0.08],
    ["entry_day_return", advantage.entryDayReturnAdvantage, (value) => value <= 0.03],
  ];
  const failed = checks
    .filter(([, value, passed]) => !Number.isFinite(value) || !passed(value))
    .map(([name]) => name);
  if (failed.length) {
    return {
      passed: false,
      reason: `board_confirmation_failed_${failed.join("_")}`,
    };
  }
  return { passed: true, reason: "board_confirmation_passed" };
}

function poolCurrentRiskGateDecision(advantage, mode) {
  if (mode === "off") {
    return { passed: true, reason: "risk_gate_off" };
  }
  if (!["relative-trend-crowding-v1", "relative-trend-crowding-v2", "relative-trend-crowding-v3", "relative-trend-crowding-v4", "relative-trend-crowding-v5"].includes(mode)) {
    throw new Error(`Unknown --pool-selector-current-risk-gate: ${mode}`);
  }

  const weakR60 = Number.isFinite(advantage.r60Advantage) && advantage.r60Advantage <= -0.10;
  const weakRelativeR60 = Number.isFinite(advantage.relativeR60Advantage) && advantage.relativeR60Advantage <= -0.05;
  const weakBenchmarkR60 = Number.isFinite(advantage.benchmarkR60Advantage) && advantage.benchmarkR60Advantage <= -0.08;
  const trendWeak = weakR60 || weakRelativeR60 || weakBenchmarkR60;
  const freshCompensationInsufficient = Number.isFinite(advantage.freshTrendAdvantage)
    ? advantage.freshTrendAdvantage < 20
    : true;
  const lotteryCrowdingWorse = Number.isFinite(advantage.lotterySpikeAdvantage) && advantage.lotterySpikeAdvantage > 8;
  const turnoverStabilityWorse = Number.isFinite(advantage.turnoverStabilityAdvantage) && advantage.turnoverStabilityAdvantage < -8;

  if (trendWeak && freshCompensationInsufficient && (lotteryCrowdingWorse || turnoverStabilityWorse)) {
    return {
      passed: false,
      reason: "relative_trend_weak_and_fresh_compensation_insufficient",
    };
  }
  const staleCrowdingWithoutFreshConfirmation = ["relative-trend-crowding-v2", "relative-trend-crowding-v3", "relative-trend-crowding-v4", "relative-trend-crowding-v5"].includes(mode) &&
    Number.isFinite(advantage.freshTrendAdvantage) &&
    Number.isFinite(advantage.lotterySpikeAdvantage) &&
    Number.isFinite(advantage.benchmarkR60Advantage) &&
    advantage.freshTrendAdvantage <= -20 &&
    advantage.lotterySpikeAdvantage > 8 &&
    advantage.benchmarkR60Advantage < 0;
  if (staleCrowdingWithoutFreshConfirmation) {
    return {
      passed: false,
      reason: "stale_crowding_without_fresh_confirmation",
    };
  }
  const freshConfirmationMissing = ["relative-trend-crowding-v3", "relative-trend-crowding-v4", "relative-trend-crowding-v5"].includes(mode) &&
    Number.isFinite(advantage.freshTrendAdvantage) &&
    advantage.freshTrendAdvantage < -5 &&
    !(
      (Number.isFinite(advantage.lotterySpikeAdvantage) && advantage.lotterySpikeAdvantage <= -3) ||
      (Number.isFinite(advantage.turnoverStabilityAdvantage) && advantage.turnoverStabilityAdvantage >= 5) ||
      (Number.isFinite(advantage.benchmarkR60Advantage) && advantage.benchmarkR60Advantage >= 0.05)
    );
  if (freshConfirmationMissing) {
    return {
      passed: false,
      reason: "fresh_confirmation_missing",
    };
  }
  const softRelativeTrendWeakWithoutRiskReduction = mode === "relative-trend-crowding-v5" &&
    Number.isFinite(advantage.relativeR60Advantage) &&
    advantage.relativeR60Advantage < 0 &&
    Number.isFinite(advantage.freshTrendAdvantage) &&
    advantage.freshTrendAdvantage < 5 &&
    Number.isFinite(advantage.lotterySpikeAdvantage) &&
    advantage.lotterySpikeAdvantage > 0 &&
    !(
      Number.isFinite(advantage.r60Advantage) &&
      advantage.r60Advantage >= 0.02
    ) &&
    !(
      Number.isFinite(advantage.benchmarkR60Advantage) &&
      advantage.benchmarkR60Advantage >= 0.05
    );
  if (softRelativeTrendWeakWithoutRiskReduction) {
    return {
      passed: false,
      reason: "soft_relative_trend_weak_without_risk_reduction",
    };
  }
  return { passed: true, reason: "current_risk_gate_passed" };
}

function physicalRelativeFeatureGateGridV1() {
  const thresholds = [{ name: "baseline_always", baselineOnly: true }];
  for (const relativeMomentumMin of [-5, 0, 2.5, 5]) {
    for (const relativeR20Min of [0, 0.01, 0.02, 0.03]) {
      for (const volumeMomentumMin of [null, -10]) {
        thresholds.push({
          name: [
            "mom",
            String(relativeMomentumMin).replace("-", "neg"),
            "r20",
            String(relativeR20Min).replace(".", "p"),
            volumeMomentumMin === null ? "vol_any" : `vol_${String(volumeMomentumMin).replace("-", "neg")}`,
          ].join("_"),
          relativeMomentumMin,
          relativeR20Min,
          volumeMomentumMin,
        });
      }
    }
  }
  return thresholds;
}

function physicalRelativeFeatureGateGridV2() {
  const thresholds = physicalRelativeFeatureGateGridV1();
  for (const relativeR60Min of [-0.05, -0.03, -0.01, 0, 0.02, 0.05, 0.08]) {
    thresholds.push({
      name: `r60_${String(relativeR60Min).replace("-", "neg").replace(".", "p")}`,
      relativeR60Min,
    });
  }
  for (const benchmarkR20Min of [0, 0.005, 0.01, 0.02]) {
    thresholds.push({
      name: `bench20_${String(benchmarkR20Min).replace(".", "p")}`,
      benchmarkR20Min,
    });
  }
  for (const turnoverStabilityMin of [-5, -3, -1, 0, 2]) {
    thresholds.push({
      name: `turnover_stability_${String(turnoverStabilityMin).replace("-", "neg")}`,
      turnoverStabilityMin,
    });
  }
  return thresholds;
}

function physicalRelativeFeatureGateGridV3() {
  const thresholds = physicalRelativeFeatureGateGridV1();
  for (const relativeR60Min of [-0.05, -0.03, -0.01, 0, 0.02, 0.05, 0.08]) {
    thresholds.push({
      name: `r60_${String(relativeR60Min).replace("-", "neg").replace(".", "p")}`,
      relativeR60Min,
    });
  }
  for (const benchmarkR20Min of [0, 0.005, 0.01, 0.02]) {
    for (const relativeR60Min of [-0.03, -0.01, 0]) {
      thresholds.push({
        name: [
          "bench20",
          String(benchmarkR20Min).replace(".", "p"),
          "r60",
          String(relativeR60Min).replace("-", "neg").replace(".", "p"),
        ].join("_"),
        benchmarkR20Min,
        relativeR60Min,
      });
    }
  }
  for (const turnoverStabilityMin of [-5, -3, -1, 0, 2]) {
    for (const relativeR60Min of [-0.03, -0.01, 0]) {
      thresholds.push({
        name: [
          "turnover_stability",
          String(turnoverStabilityMin).replace("-", "neg"),
          "r60",
          String(relativeR60Min).replace("-", "neg").replace(".", "p"),
        ].join("_"),
        turnoverStabilityMin,
        relativeR60Min,
      });
    }
  }
  return thresholds;
}

function physicalRelativeFeatureGatePass(advantage, threshold) {
  if (!threshold || threshold.baselineOnly) return false;
  const checks = [
    ["relativeMomentumMin", "relativeMomentumAdvantage"],
    ["relativeR20Min", "relativeR20Advantage"],
    ["relativeR60Min", "relativeR60Advantage"],
    ["benchmarkR20Min", "benchmarkR20Advantage"],
    ["volumeMomentumMin", "volumeMomentumAdvantage"],
    ["turnoverStabilityMin", "turnoverStabilityAdvantage"],
  ];
  return checks.every(([thresholdField, advantageField]) => {
    const min = threshold[thresholdField];
    return min == null || advantage[advantageField] >= min;
  });
}

function featureGateObjectiveReturn(row) {
  const candidates = [
    row?.netAdaptiveWeightedTopReturn,
    row?.netWeightedTopReturn,
    row?.weightedTopReturn,
  ];
  for (const value of candidates) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function featureGateObjectiveExcess(row) {
  const candidates = [
    row?.netAdaptiveExcessVsBenchmark,
    row?.netWeightedExcessVsBenchmark,
    row?.adaptiveExcessVsBenchmark,
  ];
  for (const value of candidates) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function physicalRelativeFeatureGateObservations(rowsByPool, poolDirsByName, primaryPool, baselinePool) {
  const primaryRowsByPeriod = new Map(rowsByPool.get(primaryPool).map((row) => [row.period, row]));
  const observations = [];
  for (const baselineRow of rowsByPool.get(baselinePool)) {
    const primaryRow = primaryRowsByPeriod.get(baselineRow.period);
    if (!primaryRow) continue;
    const primaryTop = topRowsFeatureSummary(readTopRowsForPoolPeriod(poolDirsByName.get(primaryPool), primaryPool, primaryRow));
    const baselineTop = topRowsFeatureSummary(readTopRowsForPoolPeriod(poolDirsByName.get(baselinePool), baselinePool, baselineRow));
    observations.push({
      period: baselineRow.period,
      asOf: baselineRow.asOf,
      end: baselineRow.end,
      primaryRow,
      baselineRow,
      advantage: physicalRelativeFeatureAdvantage(primaryTop, baselineTop),
    });
  }
  return observations;
}

function featureGateCandidateTrainingStats(trainingObservations, threshold, args) {
  const selectedRows = [];
  const returns = [];
  const excess = [];
  const deltas = [];
  let physicalSelections = 0;
  for (const observation of trainingObservations) {
    const usePrimary = physicalRelativeFeatureGatePass(observation.advantage, threshold);
    const selectedRow = usePrimary ? observation.primaryRow : observation.baselineRow;
    const selectedReturn = featureGateObjectiveReturn(selectedRow);
    const selectedExcess = featureGateObjectiveExcess(selectedRow);
    const baselineReturn = featureGateObjectiveReturn(observation.baselineRow);
    if (Number.isFinite(selectedReturn)) returns.push(selectedReturn);
    if (Number.isFinite(selectedExcess)) excess.push(selectedExcess);
    if (Number.isFinite(selectedReturn) && Number.isFinite(baselineReturn)) {
      deltas.push(selectedReturn - baselineReturn);
    }
    if (usePrimary) physicalSelections += 1;
    selectedRows.push(selectedRow);
  }
  const trainingAvgReturn = mean(returns);
  const trainingAvgExcess = mean(excess);
  const trainingAvgReturnDelta = mean(deltas);
  return {
    threshold,
    trainingAvgReturn,
    trainingAvgExcess,
    trainingScore: (trainingAvgReturn ?? -0.5) + args.poolSelectorScoreExcessWeight * (trainingAvgExcess ?? -0.5),
    trainingPeriods: Math.min(returns.length, excess.length),
    trainingReturnVol: sampleStddev(returns),
    trainingExcessVol: sampleStddev(excess),
    trainingWorstReturn: returns.length ? Math.min(...returns) : null,
    trainingWorstExcess: excess.length ? Math.min(...excess) : null,
    trainingAvgReturnDelta,
    trainingHitCount: deltas.filter((value) => value > 0).length,
    trainingPhysicalSelections: physicalSelections,
    selectedRows,
  };
}

function selectWalkForwardFeatureGateThreshold(trainingObservations, args) {
  const grid = args.poolSelectorCurrentFeatureGate === "physical-relative-wf-v3"
    ? physicalRelativeFeatureGateGridV3()
    : args.poolSelectorCurrentFeatureGate === "physical-relative-wf-v2"
      ? physicalRelativeFeatureGateGridV2()
      : physicalRelativeFeatureGateGridV1();
  return grid
    .map((threshold) => featureGateCandidateTrainingStats(trainingObservations, threshold, args))
    .sort((a, b) => {
      const scoreDelta = (b.trainingScore ?? -Infinity) - (a.trainingScore ?? -Infinity);
      if (scoreDelta) return scoreDelta;
      const returnDelta = (b.trainingAvgReturn ?? -Infinity) - (a.trainingAvgReturn ?? -Infinity);
      if (returnDelta) return returnDelta;
      const worstDelta = (b.trainingWorstReturn ?? -Infinity) - (a.trainingWorstReturn ?? -Infinity);
      if (worstDelta) return worstDelta;
      const selectionDelta = a.trainingPhysicalSelections - b.trainingPhysicalSelections;
      if (selectionDelta) return selectionDelta;
      return String(a.threshold.name).localeCompare(String(b.threshold.name));
    })[0];
}

function featureGateSelectionRow({
  observation,
  selectedRow,
  selectedPool,
  primaryPool,
  baselinePool,
  mode,
  poolSelectionReason,
  featureGateReason,
  threshold,
  trainingStats,
  trainingLookbackPeriods,
}) {
  const advantage = observation.advantage;
  return {
    ...selectedRow,
    selectedPool,
    selectedPoolParam: selectedRow.selectedParam,
    poolSelectionReason,
    candidatePool: selectedPool,
    candidatePoolTrainingScore: trainingStats?.trainingScore ?? null,
    featureGateMode: mode,
    featureGateReason,
    featureGatePrimaryPool: primaryPool,
    featureGateBaselinePool: baselinePool,
    featureGateRelativeMomentumAdvantage: round(advantage.relativeMomentumAdvantage, 6),
    featureGateRelativeR20Advantage: round(advantage.relativeR20Advantage, 6),
    featureGateRelativeR60Advantage: round(advantage.relativeR60Advantage, 6),
    featureGateBenchmarkR20Advantage: round(advantage.benchmarkR20Advantage, 6),
    featureGateVolumeMomentumAdvantage: round(advantage.volumeMomentumAdvantage, 6),
    featureGateVolumeTurnoverAdvantage: round(advantage.volumeTurnoverAdvantage, 6),
    featureGateTurnoverStabilityAdvantage: round(advantage.turnoverStabilityAdvantage, 6),
    featureGateEntryDayReturnAdvantage: round(advantage.entryDayReturnAdvantage, 6),
    featureGateThresholdName: threshold?.name ?? "",
    featureGateMomentumThreshold: threshold?.baselineOnly ? "" : round(threshold?.relativeMomentumMin, 6),
    featureGateR20Threshold: threshold?.baselineOnly ? "" : round(threshold?.relativeR20Min, 6),
    featureGateR60Threshold: threshold?.baselineOnly ? "" : round(threshold?.relativeR60Min, 6),
    featureGateBenchmarkR20Threshold: threshold?.baselineOnly ? "" : round(threshold?.benchmarkR20Min, 6),
    featureGateVolumeMomentumThreshold: threshold?.baselineOnly || threshold?.volumeMomentumMin === null ? "" : round(threshold?.volumeMomentumMin, 6),
    featureGateTurnoverStabilityThreshold: threshold?.baselineOnly ? "" : round(threshold?.turnoverStabilityMin, 6),
    featureGateTrainingPhysicalSelections: trainingStats?.trainingPhysicalSelections ?? "",
    featureGateTrainingAvgReturnDelta: round(trainingStats?.trainingAvgReturnDelta, 6),
    featureGateTrainingHitCount: trainingStats?.trainingHitCount ?? "",
    eligiblePoolCount: 2,
    trainingScore: trainingStats?.trainingScore ?? null,
    trainingAvgReturn: trainingStats?.trainingAvgReturn ?? null,
    trainingAvgExcess: trainingStats?.trainingAvgExcess ?? null,
    trainingPeriods: trainingStats?.trainingPeriods ?? 0,
    trainingLookbackPeriods,
    trainingReturnVol: trainingStats?.trainingReturnVol ?? null,
    trainingExcessVol: trainingStats?.trainingExcessVol ?? null,
    trainingWorstReturn: trainingStats?.trainingWorstReturn ?? null,
    trainingWorstExcess: trainingStats?.trainingWorstExcess ?? null,
  };
}

function featureGateSelectedRows(rowsByPool, poolDirsByName, args) {
  const mode = args.poolSelectorCurrentFeatureGate || "off";
  if (mode === "off") return null;
  if (!["physical-relative-v1", "physical-relative-wf-v1", "physical-relative-wf-v2", "physical-relative-wf-v3"].includes(mode)) {
    throw new Error(`Unknown --pool-selector-current-feature-gate: ${mode}`);
  }
  const primaryPool = "physical";
  const baselinePool = args.poolSelectorBaselinePool || "merged";
  if (!rowsByPool.has(primaryPool)) {
    throw new Error(`--pool-selector-current-feature-gate ${mode} requires pool '${primaryPool}'`);
  }
  if (!rowsByPool.has(baselinePool)) {
    throw new Error(`--pool-selector-current-feature-gate ${mode} requires baseline pool '${baselinePool}'`);
  }
  const observations = physicalRelativeFeatureGateObservations(rowsByPool, poolDirsByName, primaryPool, baselinePool);
  const selectedRows = [];
  if (mode === "physical-relative-v1") {
    const threshold = {
      name: "fixed_mom_5_r20_0p02",
      relativeMomentumMin: 5,
      relativeR20Min: 0.02,
      volumeMomentumMin: null,
    };
    for (const observation of observations) {
      const usePrimary = physicalRelativeFeatureGatePass(observation.advantage, threshold);
      const sourceRow = usePrimary ? observation.primaryRow : observation.baselineRow;
      selectedRows.push(featureGateSelectionRow({
        observation,
        selectedRow: sourceRow,
        selectedPool: usePrimary ? primaryPool : baselinePool,
        primaryPool,
        baselinePool,
        mode,
        poolSelectionReason: usePrimary ? "selected_by_current_feature_gate" : "kept_feature_baseline_pool",
        featureGateReason: usePrimary ? "physical_relative_momentum_and_r20_advantage" : "physical_relative_advantage_insufficient",
        threshold,
        trainingStats: null,
        trainingLookbackPeriods: 0,
      }));
    }
    return selectedRows;
  }

  for (let index = 0; index < observations.length; index += 1) {
    const observation = observations[index];
    const start = Math.max(0, index - args.poolSelectorLookback);
    const rawTraining = observations.slice(start, index);
    const trainingObservations = rawTraining.filter((row) => row.end <= observation.asOf);
    const trainingLookbackPeriods = index - start;
    if (trainingObservations.length < args.poolSelectorMinTrain) {
      const threshold = { name: "baseline_warmup", baselineOnly: true };
      selectedRows.push(featureGateSelectionRow({
        observation,
        selectedRow: observation.baselineRow,
        selectedPool: baselinePool,
        primaryPool,
        baselinePool,
        mode,
        poolSelectionReason: "warmup_feature_baseline_pool",
        featureGateReason: "walk_forward_feature_gate_training_insufficient",
        threshold,
        trainingStats: {
          threshold,
          trainingPeriods: trainingObservations.length,
          trainingPhysicalSelections: 0,
          trainingHitCount: 0,
          trainingAvgReturnDelta: 0,
        },
        trainingLookbackPeriods,
      }));
      continue;
    }
    const trainingStats = selectWalkForwardFeatureGateThreshold(trainingObservations, args);
    const usePrimary = physicalRelativeFeatureGatePass(observation.advantage, trainingStats.threshold);
    const sourceRow = usePrimary ? observation.primaryRow : observation.baselineRow;
    selectedRows.push(featureGateSelectionRow({
      observation,
      selectedRow: sourceRow,
      selectedPool: usePrimary ? primaryPool : baselinePool,
      primaryPool,
      baselinePool,
      mode,
      poolSelectionReason: usePrimary ? "selected_by_walk_forward_feature_gate" : "kept_walk_forward_feature_baseline_pool",
      featureGateReason: usePrimary ? "walk_forward_feature_gate_passed" : "walk_forward_feature_gate_failed",
      threshold: trainingStats.threshold,
      trainingStats,
      trainingLookbackPeriods,
    }));
  }
  return selectedRows;
}

function poolCurrentRiskGateFields({ mode, decision, selectedPool, blockedPool, baselinePool, advantage }) {
  return {
    riskGateMode: mode,
    riskGatePassed: decision.passed ? 1 : 0,
    riskGateReason: decision.reason,
    riskGateSelectedPool: selectedPool,
    riskGateBlockedPool: blockedPool || "",
    riskGateBaselinePool: baselinePool,
    riskGateR60Advantage: round(advantage?.r60Advantage, 6),
    riskGateRelativeR60Advantage: round(advantage?.relativeR60Advantage, 6),
    riskGateBenchmarkR60Advantage: round(advantage?.benchmarkR60Advantage, 6),
    riskGateFreshTrendAdvantage: round(advantage?.freshTrendAdvantage, 6),
    riskGateLotterySpikeAdvantage: round(advantage?.lotterySpikeAdvantage, 6),
    riskGateTurnoverStabilityAdvantage: round(advantage?.turnoverStabilityAdvantage, 6),
  };
}

function poolPeriodKey(row) {
  return row.period || `${row.asOf}:${row.end}`;
}

function isBoardPoolName(name) {
  const normalized = String(name || "").replace(/[-_\s]/g, "").toLowerCase();
  return [
    "chinext",
    "szmain",
    "shmain",
    "star",
    "bj",
    "bse",
    "beijing",
    "pitcachechinext",
    "pitcacheszmain",
    "pitcacheshmain",
    "pitcachestar",
    "pitcachebj",
  ].includes(normalized);
}

function poolBoardConfirmationFields({ decision, selectedPool, blockedPool, fallbackPool, baselinePool, advantage }) {
  return {
    boardGateMode: "board-confirmation-v1",
    boardGatePassed: decision.passed ? 1 : 0,
    boardGateReason: decision.reason,
    boardGateSelectedPool: selectedPool,
    boardGateBlockedPool: blockedPool || "",
    boardGateFallbackPool: fallbackPool || "",
    boardGateBaselinePool: baselinePool,
    boardGateFreshTrendAdvantage: round(advantage?.freshTrendAdvantage, 6),
    boardGateVolumeMomentumAdvantage: round(advantage?.volumeMomentumAdvantage, 6),
    boardGateLotterySpikeAdvantage: round(advantage?.lotterySpikeAdvantage, 6),
    boardGateTurnoverStabilityAdvantage: round(advantage?.turnoverStabilityAdvantage, 6),
    boardGateRelativeMomentumAdvantage: round(advantage?.relativeMomentumAdvantage, 6),
    boardGateRelativeR20Advantage: round(advantage?.relativeR20Advantage, 6),
    boardGateEntryDayReturnAdvantage: round(advantage?.entryDayReturnAdvantage, 6),
  };
}

function poolSelectorUpstreamGateFields(row) {
  const fields = {};
  for (const [key, value] of Object.entries(row || {})) {
    if (key.startsWith("featureGate") || key.startsWith("boardGate")) {
      fields[key] = value;
    }
  }
  return fields;
}

function buildNonBoardPoolSelections(rowsByPool, args, initialPool) {
  const entries = Array.from(rowsByPool.entries()).filter(([name]) => !isBoardPoolName(name));
  if (!entries.length) return new Map();
  const baselinePool = args.poolSelectorBaselinePool || "";
  const nonBoardInitialPool = entries.some(([name]) => name === initialPool)
    ? initialPool
    : (baselinePool && entries.some(([name]) => name === baselinePool) ? baselinePool : entries[0][0]);
  const rows = walkForwardPoolSelect(Object.fromEntries(entries), {
    minTrainPeriods: args.poolSelectorMinTrain,
    lookbackPeriods: args.poolSelectorLookback,
    initialPool: nonBoardInitialPool,
    scoreExcessWeight: args.poolSelectorScoreExcessWeight,
    incumbentPolicy: args.poolSelectorIncumbentPolicy,
    switchMargin: args.poolSelectorSwitchMargin,
    knownOutcomeOnly: args.poolSelectorKnownOutcomeOnly,
    includeWarmup: args.poolSelectorIncludeWarmup,
  });
  return new Map(rows.map((row) => [poolPeriodKey(row), row]));
}

function applyPoolSelectorBoardConfirmationGate(selectedRows, rowsByPool, poolDirsByName, args, initialPool) {
  const mode = String(args.poolSelectorCurrentRiskGate || "off").toLowerCase();
  if (mode !== "relative-trend-crowding-v4") return selectedRows;
  const baselinePool = args.poolSelectorBaselinePool || "merged";
  if (!rowsByPool.has(baselinePool)) {
    throw new Error(`--pool-selector-current-risk-gate ${mode} requires baseline pool '${baselinePool}'`);
  }
  const baselineRowsByPeriod = new Map(rowsByPool.get(baselinePool).map((row) => [
    poolPeriodKey(row),
    row,
  ]));
  const fallbackRowsByPeriod = buildNonBoardPoolSelections(rowsByPool, args, initialPool);

  return selectedRows.map((row) => {
    const originalSelectedPool = row.selectedPool;
    if (!originalSelectedPool || !isBoardPoolName(originalSelectedPool)) {
      return {
        ...row,
        ...poolBoardConfirmationFields({
          decision: { passed: true, reason: originalSelectedPool ? "non_board_pool" : "missing_selected_pool" },
          selectedPool: originalSelectedPool,
          blockedPool: "",
          fallbackPool: "",
          baselinePool,
          advantage: null,
        }),
      };
    }
    if (String(row.poolSelectionReason || "").startsWith("warmup_")) {
      return {
        ...row,
        ...poolBoardConfirmationFields({
          decision: { passed: true, reason: "warmup_not_checked" },
          selectedPool: originalSelectedPool,
          blockedPool: "",
          fallbackPool: "",
          baselinePool,
          advantage: null,
        }),
      };
    }
    const periodKey = poolPeriodKey(row);
    const baselineRow = baselineRowsByPeriod.get(periodKey);
    if (!baselineRow) {
      return {
        ...row,
        ...poolBoardConfirmationFields({
          decision: { passed: true, reason: "missing_baseline_row" },
          selectedPool: originalSelectedPool,
          blockedPool: "",
          fallbackPool: "",
          baselinePool,
          advantage: null,
        }),
      };
    }
    const candidateTop = topRowsFeatureSummary(readTopRowsForPoolPeriod(poolDirsByName.get(originalSelectedPool), originalSelectedPool, row));
    const baselineTop = topRowsFeatureSummary(readTopRowsForPoolPeriod(poolDirsByName.get(baselinePool), baselinePool, baselineRow));
    const advantage = poolCurrentBoardFeatureAdvantage(candidateTop, baselineTop);
    const decision = poolBoardConfirmationDecision(advantage);
    if (decision.passed) {
      return {
        ...row,
        ...poolBoardConfirmationFields({
          decision,
          selectedPool: originalSelectedPool,
          blockedPool: "",
          fallbackPool: "",
          baselinePool,
          advantage,
        }),
      };
    }

    const fallbackRow = fallbackRowsByPeriod.get(periodKey) || baselineRow;
    const fallbackPool = fallbackRow.selectedPool || (fallbackRow === baselineRow ? baselinePool : "");
    return {
      ...fallbackRow,
      periodIndex: row.periodIndex ?? fallbackRow.periodIndex,
      period: row.period || fallbackRow.period || `${fallbackRow.asOf}:${fallbackRow.end}`,
      asOf: row.asOf ?? fallbackRow.asOf,
      end: row.end ?? fallbackRow.end,
      selectedPool: fallbackPool,
      selectedPoolParam: fallbackRow.selectedParam ?? fallbackRow.selectedPoolParam ?? null,
      poolSelectionReason: "blocked_by_board_confirmation_gate",
      candidatePool: originalSelectedPool,
      candidatePoolTrainingScore: row.candidatePoolTrainingScore ?? row.trainingScore ?? null,
      incumbentPool: fallbackRow.incumbentPool ?? row.incumbentPool ?? null,
      incumbentPoolTrainingScore: fallbackRow.incumbentPoolTrainingScore ?? row.incumbentPoolTrainingScore ?? null,
      poolScoreAdvantage: fallbackRow.poolScoreAdvantage ?? row.poolScoreAdvantage ?? null,
      eligiblePoolCount: fallbackRow.eligiblePoolCount ?? row.eligiblePoolCount ?? null,
      trainingScore: fallbackRow.trainingScore ?? row.trainingScore ?? null,
      trainingAvgReturn: fallbackRow.trainingAvgReturn ?? row.trainingAvgReturn ?? null,
      trainingAvgExcess: fallbackRow.trainingAvgExcess ?? row.trainingAvgExcess ?? null,
      trainingPeriods: fallbackRow.trainingPeriods ?? row.trainingPeriods ?? 0,
      trainingLookbackPeriods: fallbackRow.trainingLookbackPeriods ?? row.trainingLookbackPeriods ?? 0,
      trainingReturnVol: fallbackRow.trainingReturnVol ?? row.trainingReturnVol ?? null,
      trainingExcessVol: fallbackRow.trainingExcessVol ?? row.trainingExcessVol ?? null,
      trainingWorstReturn: fallbackRow.trainingWorstReturn ?? row.trainingWorstReturn ?? null,
      trainingWorstExcess: fallbackRow.trainingWorstExcess ?? row.trainingWorstExcess ?? null,
      ...poolBoardConfirmationFields({
        decision,
        selectedPool: fallbackPool,
        blockedPool: originalSelectedPool,
        fallbackPool,
        baselinePool,
        advantage,
      }),
    };
  });
}

function applyPoolSelectorCurrentRiskGate(selectedRows, rowsByPool, poolDirsByName, args) {
  const mode = String(args.poolSelectorCurrentRiskGate || "off").toLowerCase();
  if (mode === "off") return selectedRows;
  const baselinePool = args.poolSelectorBaselinePool || "merged";
  if (!rowsByPool.has(baselinePool)) {
    throw new Error(`--pool-selector-current-risk-gate ${mode} requires baseline pool '${baselinePool}'`);
  }
  const baselineRowsByPeriod = new Map(rowsByPool.get(baselinePool).map((row) => [
    poolPeriodKey(row),
    row,
  ]));

  return selectedRows.map((row) => {
    const originalSelectedPool = row.selectedPool;
    if (!originalSelectedPool || originalSelectedPool === baselinePool) {
      const decision = { passed: true, reason: originalSelectedPool === baselinePool ? "selected_baseline_pool" : "missing_selected_pool" };
      return {
        ...row,
        ...poolCurrentRiskGateFields({
          mode,
          decision,
          selectedPool: originalSelectedPool,
          blockedPool: "",
          baselinePool,
          advantage: null,
        }),
      };
    }
    if (String(row.poolSelectionReason || "").startsWith("warmup_")) {
      return {
        ...row,
        ...poolCurrentRiskGateFields({
          mode,
          decision: { passed: true, reason: "warmup_not_checked" },
          selectedPool: originalSelectedPool,
          blockedPool: "",
          baselinePool,
          advantage: null,
        }),
      };
    }
    const baselineRow = baselineRowsByPeriod.get(poolPeriodKey(row));
    if (!baselineRow) {
      return {
        ...row,
        ...poolCurrentRiskGateFields({
          mode,
          decision: { passed: true, reason: "missing_baseline_row" },
          selectedPool: originalSelectedPool,
          blockedPool: "",
          baselinePool,
          advantage: null,
        }),
      };
    }
    const candidateTop = topRowsFeatureSummary(readTopRowsForPoolPeriod(poolDirsByName.get(originalSelectedPool), originalSelectedPool, row));
    const baselineTop = topRowsFeatureSummary(readTopRowsForPoolPeriod(poolDirsByName.get(baselinePool), baselinePool, baselineRow));
    const advantage = poolCurrentRiskFeatureAdvantage(candidateTop, baselineTop);
    const decision = poolCurrentRiskGateDecision(advantage, mode);
    const fields = poolCurrentRiskGateFields({
      mode,
      decision,
      selectedPool: decision.passed ? originalSelectedPool : baselinePool,
      blockedPool: decision.passed ? "" : originalSelectedPool,
      baselinePool,
      advantage,
    });
    if (decision.passed) {
      return {
        ...row,
        ...fields,
      };
    }
    return {
      ...baselineRow,
      periodIndex: row.periodIndex ?? baselineRow.periodIndex,
      period: row.period || baselineRow.period || `${baselineRow.asOf}:${baselineRow.end}`,
      asOf: row.asOf ?? baselineRow.asOf,
      end: row.end ?? baselineRow.end,
      selectedPool: baselinePool,
      selectedPoolParam: baselineRow.selectedParam ?? baselineRow.selectedPoolParam ?? null,
      poolSelectionReason: "blocked_by_current_risk_gate",
      candidatePool: row.candidatePool ?? originalSelectedPool,
      candidatePoolTrainingScore: row.candidatePoolTrainingScore ?? row.trainingScore ?? null,
      incumbentPool: row.incumbentPool ?? null,
      incumbentPoolTrainingScore: row.incumbentPoolTrainingScore ?? null,
      poolScoreAdvantage: row.poolScoreAdvantage ?? null,
      eligiblePoolCount: row.eligiblePoolCount ?? null,
      trainingScore: row.trainingScore ?? null,
      trainingAvgReturn: row.trainingAvgReturn ?? null,
      trainingAvgExcess: row.trainingAvgExcess ?? null,
      trainingPeriods: row.trainingPeriods ?? 0,
      trainingLookbackPeriods: row.trainingLookbackPeriods ?? 0,
      trainingReturnVol: row.trainingReturnVol ?? null,
      trainingExcessVol: row.trainingExcessVol ?? null,
      trainingWorstReturn: row.trainingWorstReturn ?? null,
      trainingWorstExcess: row.trainingWorstExcess ?? null,
      ...poolSelectorUpstreamGateFields(row),
      ...fields,
    };
  });
}

function runPoolSelectorMode(args) {
  if (!args.poolSelectorDirs?.length) {
    throw new Error("--pool-selector-dirs is required for pool selector mode");
  }
  const outDir = args.outDir || path.join(DEFAULT_OUTPUT_ROOT, `pool-selector-${timestamp()}`);
  ensureDir(outDir);

  const rowsByPool = new Map();
  const poolDirsByName = new Map();
  for (const pool of args.poolSelectorDirs) {
    rowsByPool.set(pool.name, readWalkForwardRowsForPool(pool));
    poolDirsByName.set(pool.name, pool.dir);
  }
  const initialPool = args.poolSelectorInitialPool || args.poolSelectorDirs[0].name;
  const rawSelectedRows = featureGateSelectedRows(rowsByPool, poolDirsByName, args) || walkForwardPoolSelect(Object.fromEntries(rowsByPool.entries()), {
      minTrainPeriods: args.poolSelectorMinTrain,
      lookbackPeriods: args.poolSelectorLookback,
      initialPool,
      scoreExcessWeight: args.poolSelectorScoreExcessWeight,
      incumbentPolicy: args.poolSelectorIncumbentPolicy,
      switchMargin: args.poolSelectorSwitchMargin,
      knownOutcomeOnly: args.poolSelectorKnownOutcomeOnly,
      includeWarmup: args.poolSelectorIncludeWarmup,
    });
  const boardFilteredRows = applyPoolSelectorBoardConfirmationGate(rawSelectedRows, rowsByPool, poolDirsByName, args, initialPool);
  const selectedRows = applyPoolSelectorCurrentRiskGate(boardFilteredRows, rowsByPool, poolDirsByName, args);
  if (!selectedRows.length) {
    throw new Error("Pool selector produced no rows");
  }
  const trainedRows = selectedRows.filter((row) => !String(row.poolSelectionReason || "").startsWith("warmup_"));
  const warmupRowCount = selectedRows.length - trainedRows.length;
  const baselinePool = args.poolSelectorBaselinePool || "";
  if (baselinePool && !rowsByPool.has(baselinePool)) {
    throw new Error(`Unknown --pool-selector-baseline: ${baselinePool}`);
  }
  const baselineRows = baselinePool ? rowsByPool.get(baselinePool) : [];

  const fixedPoolSummaries = {};
  for (const [name, rows] of rowsByPool.entries()) {
    fixedPoolSummaries[name] = summarizePoolSelectorRows(rows);
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    outDir,
    mode: "pool_selector_v1",
    rowCount: selectedRows.length,
    inputPools: args.poolSelectorDirs,
    options: {
      minTrainPeriods: args.poolSelectorMinTrain,
      lookbackPeriods: args.poolSelectorLookback,
      initialPool,
      scoreExcessWeight: args.poolSelectorScoreExcessWeight,
      incumbentPolicy: args.poolSelectorIncumbentPolicy,
      switchMargin: args.poolSelectorSwitchMargin,
      knownOutcomeOnly: args.poolSelectorKnownOutcomeOnly,
      includeWarmup: args.poolSelectorIncludeWarmup,
      baselinePool,
      currentFeatureGate: args.poolSelectorCurrentFeatureGate,
      currentRiskGate: args.poolSelectorCurrentRiskGate,
    },
    summary: summarizePoolSelectorRows(selectedRows),
    warmupRowCount,
    trainedSummary: summarizePoolSelectorRows(trainedRows),
    baselineComparison: baselinePool
      ? comparePoolSelectorRowsToBaseline(selectedRows, baselineRows, baselinePool)
      : null,
    trainedBaselineComparison: baselinePool
      ? comparePoolSelectorRowsToBaseline(trainedRows, baselineRows, baselinePool)
      : null,
    fixedPoolSummaries,
    caveats: [
      "池级选择只读取各输入目录已生成的 walk_forward_summary.csv；其底层股票池、参数和数据边界需回看原目录报告。",
      "每期选择只用之前区间的池级净自适应收益和净超大盘训练分；当 includeWarmup=true 时，训练不足期使用 initialPool 输出以便同口径比较。",
      "这仍是历史诊断，不代表未来收益保证；若输入股票池来自当前主题快照，仍需继续降低 point-in-time 股票池偏差。",
    ],
  };

  writeCsv(
    path.join(outDir, "walk_forward_pool_selector_summary.csv"),
    selectedRows,
    headersForRows(selectedRows, POOL_SELECTOR_PREFERRED_HEADERS)
  );
  fs.writeFileSync(path.join(outDir, "pool_selector_summary.json"), JSON.stringify(summary, null, 2));

  console.log(`[alpha-backtest] pool_selector out=${outDir}`);
  console.log(`[alpha-backtest] pool_selector rows=${selectedRows.length} avg_net_adaptive=${pct(summary.summary.avgNetAdaptiveWeightedTopReturn)} avg_net_ax_bench=${pct(summary.summary.avgNetAdaptiveExcessVsBenchmark)}`);
  return { outDir, rows: selectedRows, summary };
}

function writeResultArtifacts(outDir, selectedName, selectedResults, optimizationRows, metadata) {
  const headers = [
    "rank",
    "code",
    "name",
    "market",
    "industry",
    "universeSource",
    "score",
    "rawScore",
    "crossSectionScore",
    "recommendedWeight",
    "recommendedWeightPct",
    "forwardReturn",
    "executionCostRate",
    "netForwardReturn",
    "benchmarkForwardReturn",
    "benchmarkExecutionCostRate",
    "netBenchmarkForwardReturn",
    "excessVsBenchmark",
    "netExcessVsBenchmark",
    "priceAsOf",
    "entryDayReturn",
    "entryTurnover",
    "entryCloseAtHigh",
    "entryDate",
    "targetExitDate",
    "exitDate",
    "exitDelayDays",
    "exitReason",
    "exitDayReturn",
    "exitTurnover",
    "exitCloseAtLow",
    "r5",
    "r20",
    "r60",
    "acceleration20vs60",
    "dd60",
    "vol20",
    "avgTurnover20",
    "pullbackAccumulationScore",
    "pullbackDrawdown20",
    "pullbackSupportRatio20",
    "pullbackVolumeRatio5v20",
    "volumeMomentumScore",
    "volumeTurnoverRatio5v20",
    "shortTermReversalScore",
    "shortTermReversalR3",
    "shortTermDrawdown20",
    "shortTermSupportRatio20",
    "turnoverCv20",
    "turnoverStabilityScore",
    "freshTrendScore",
    "freshAccelerationScore",
    "trendMaturityPenaltyScore",
    "high52wScore",
    "high52wDistance",
    "high52wDaysSinceHigh",
    "maxDailyReturn20",
    "maxPositiveShare20",
    "lotterySpikeScore",
    "momentumScore",
    "liquidityScore",
    "stabilityScore",
    "themeScore",
    "benchmarkR5",
    "benchmarkR20",
    "benchmarkR60",
    "relativeR5",
    "relativeR20",
    "relativeR60",
    "relativeMomentumScore",
    "industryCount",
    "industryR20",
    "industryR60",
    "industryRelativeR20",
    "industryRelativeR60",
    "industryBreadth20",
    "industryMomentumScore",
    "industryResidualR20",
    "industryResidualR60",
    "industryResidualRelativeR20",
    "industryResidualRelativeR60",
    "industryResidualMomentumScore",
    "dynamicGroupKey",
    "dynamicGroupCount",
    "dynamicGroupR20",
    "dynamicGroupR60",
    "dynamicGroupRelativeR20",
    "dynamicGroupRelativeR60",
    "dynamicGroupBreadth20",
    "dynamicGroupScore",
    "scoreBeforeDynamicGroupBlend",
    "dynamicGroupScoreBlendWeight",
    "dynamicGroupRankScore",
    "trendRankScore",
    "accelerationRankScore",
    "riskRankScore",
    "liquidityRankScore",
    "themeRankScore",
    "relativeRankScore",
    "relativeMomentumRankScore",
    "benchmarkTrendRankScore",
    "industryRankScore",
    "industryResidualRankScore",
    "pullbackRankScore",
    "volumeMomentumRankScore",
    "shortTermReversalRankScore",
    "turnoverStabilityRankScore",
    "freshTrendRankScore",
    "lotterySpikeRankScore",
    "high52wRankScore",
    "consistencyRankScore",
    "overheatPenaltyScore",
  ];
  const periodSummaryRows = selectedResults.map((result) => summarizePeriodResult(result, selectedName));
  for (const result of selectedResults) {
    const slug = `${result.asOf}_${result.end}`;
    writeCsv(path.join(outDir, `top${result.topN}_${slug}.csv`), csvRowsForScored(result.top), headers);
    writeCsv(path.join(outDir, `scored_${slug}.csv`), csvRowsForScored(result.scored), headers);
    writeCsv(path.join(outDir, `skipped_${slug}.csv`), result.skipped, ["code", "name", "reason", "historyDays", "avgTurnover20", "priceAsOf", "vol20", "dynamicGroupKey", "dynamicGroupCount", "dynamicGroupR20", "dynamicGroupR60", "dynamicGroupRelativeR20", "dynamicGroupRelativeR60", "dynamicGroupBreadth20", "dynamicGroupScore", "forwardReturn", "entryDate", "targetExitDate", "exitDate", "exitDelayDays", "entryPrice", "exitPrice", "entryDayReturn", "entryTurnover", "exitDayReturn", "exitTurnover", "sanityMaxForwardReturn", "sanityMinForwardReturn", "sanityJumpDate", "sanityPriceRatio", "sanityVolumeRatio"]);
  }
  if (metadata.walkForwardSelectedResults?.length) {
    for (const result of metadata.walkForwardSelectedResults) {
      const slug = `${result.asOf}_${result.end}`;
      writeCsv(path.join(outDir, `walk_forward_top${result.topN}_${slug}.csv`), csvRowsForScored(result.top), headers);
      writeCsv(path.join(outDir, `walk_forward_scored_${slug}.csv`), csvRowsForScored(result.scored), headers);
      writeCsv(path.join(outDir, `walk_forward_skipped_${slug}.csv`), result.skipped, ["code", "name", "reason", "historyDays", "avgTurnover20", "priceAsOf", "vol20", "dynamicGroupKey", "dynamicGroupCount", "dynamicGroupR20", "dynamicGroupR60", "dynamicGroupRelativeR20", "dynamicGroupRelativeR60", "dynamicGroupBreadth20", "dynamicGroupScore", "forwardReturn", "entryDate", "targetExitDate", "exitDate", "exitDelayDays", "entryPrice", "exitPrice", "entryDayReturn", "entryTurnover", "exitDayReturn", "exitTurnover", "sanityMaxForwardReturn", "sanityMinForwardReturn", "sanityJumpDate", "sanityPriceRatio", "sanityVolumeRatio"]);
    }
  }
  writeCsv(path.join(outDir, "period_summary.csv"), periodSummaryRows, Object.keys(periodSummaryRows[0] || {}));
  writeCsv(path.join(outDir, "optimization_grid.csv"), optimizationRows, Object.keys(optimizationRows[0] || {}));
  if (metadata.optimizationPeriodRows?.length) {
    writeCsv(path.join(outDir, "optimization_periods.csv"), metadata.optimizationPeriodRows, Object.keys(metadata.optimizationPeriodRows[0]));
  }
  if (metadata.walkForwardRows?.length) {
    writeCsv(path.join(outDir, "walk_forward_summary.csv"), metadata.walkForwardRows, Object.keys(metadata.walkForwardRows[0]));
  }
  if (metadata.walkForwardEnsembleRows?.length) {
    writeCsv(path.join(outDir, "walk_forward_ensemble_summary.csv"), metadata.walkForwardEnsembleRows, Object.keys(metadata.walkForwardEnsembleRows[0]));
  }
  if (metadata.benchmarkSummaryRows?.length) {
    writeCsv(path.join(outDir, "benchmark_summary.csv"), metadata.benchmarkSummaryRows, Object.keys(metadata.benchmarkSummaryRows[0]));
  }
  if (metadata.mainIndexSummaryRows?.length) {
    writeCsv(path.join(outDir, "main_index_summary.csv"), metadata.mainIndexSummaryRows, Object.keys(metadata.mainIndexSummaryRows[0]));
  }
  if (metadata.universeFieldAudit?.fields?.length) {
    const rows = csvRowsForUniverseFieldAudit(metadata.universeFieldAudit);
    writeCsv(path.join(outDir, "universe_field_audit.csv"), rows, Object.keys(rows[0]));
  }
  const jsonMetadata = { ...metadata };
  delete jsonMetadata.walkForwardSelectedResults;
  fs.writeFileSync(
    path.join(outDir, "backtest_summary.json"),
    JSON.stringify({ ...jsonMetadata, selectedParam: selectedName, periodSummaryRows, optimizationRows }, null, 2)
  );
}

function walkForwardSelectedResultsForArtifacts(walkForwardRows, periodResultsByParam) {
  if (!walkForwardRows?.length || !periodResultsByParam?.size) return [];
  const results = [];
  for (const row of walkForwardRows) {
    const paramResults = periodResultsByParam.get(row.selectedParam);
    if (!paramResults?.length) continue;
    const match = paramResults.find((result) => result.asOf === row.asOf && result.end === row.end);
    if (match) results.push(match);
  }
  return results;
}

function buildMarkdownReport(report) {
  const lines = [];
  const latest = report.periods.at(-1);
  const latestSig = latest?.significant5pct ? "达到 5% 显著性" : "未达到 5% 显著性";
  lines.push("# Alpha Backtest Report");
  lines.push("");
  lines.push(`生成时间：${report.generatedAt}`);
  lines.push(`股票池：${report.universeFile}`);
  lines.push(`覆盖：输入 ${report.inputCount} 只，成功抓取 ${report.klineOkCount} 只，抓取失败 ${report.klineFailedCount} 只。`);
  lines.push(`选用参数：${report.selectedParam}`);
  lines.push("");
  lines.push("## 短结论");
  lines.push("");
  if (latest) {
    lines.push(`- 最近留出/最后区间 ${latest.period}：净自适应收益 ${pct(latest.netAdaptiveWeightedTopReturn)}，毛自适应收益 ${pct(latest.adaptiveWeightedTopReturn)}，净推荐仓位收益 ${pct(latest.netWeightedTopReturn)}，指数袖珍仓位 ${pct(latest.benchmarkOverlayWeight)}，现金 ${pct(latest.defensiveCashWeight)}（弱势 ${pct(latest.weakMarketCashWeight)}，过热降速 ${pct(latest.exhaustionCashWeight)}），净大盘基准 ${pct(latest.netWeightedBenchmarkReturn)}，净自适应相对大盘超额 ${pct(latest.netAdaptiveExcessVsBenchmark)}。`);
    lines.push(`- 同期净股票池平均 ${pct(latest.netUniverseMeanReturn)}，净自适应组合相对股票池超额 ${pct(latest.netAdaptiveWeightedExcessReturn)}；等权 Top${report.topN} 显著性 ${latestSig}。`);
    lines.push("- HTML 和 `main_index_summary.csv` 已单独列出上证、深成、沪深300、中证500、中证1000、创业板、科创50、恒生、恒生科技等主流指数对比。");
  }
  if (report.walkForwardRows?.length) {
    const wfReturns = report.walkForwardRows.map((row) => Number(row.netAdaptiveWeightedTopReturn)).filter(Number.isFinite);
    const wfExcess = report.walkForwardRows.map((row) => Number(row.netAdaptiveExcessVsBenchmark)).filter(Number.isFinite);
    const policyNote = report.walkForwardStableParam && report.walkForwardIncumbentPolicy === "stable" ? "，每期对生产基线重比" : "";
    const stableNote = report.walkForwardStableParam ? `，incumbent=${report.walkForwardStableParam}，切换门槛 ${pct(report.walkForwardSwitchMargin)}${policyNote}` : "";
    const warmupNote = report.walkForwardMinExploratoryPeriods ? `，探索 warm-up=${report.walkForwardMinExploratoryPeriods} 期` : "";
    lines.push(`- Walk-forward（每期只用之前区间选参数${stableNote}${warmupNote}）覆盖 ${report.walkForwardRows.length} 个区间：平均净自适应收益 ${pct(mean(wfReturns))}，平均净超大盘 ${pct(mean(wfExcess))}，跑赢大盘命中率 ${pct(mean(wfExcess.map((x) => (x > 0 ? 1 : 0))))}。`);
  }
  if (report.walkForwardEnsembleRows?.length) {
    const wfReturns = report.walkForwardEnsembleRows.map((row) => Number(row.netAdaptiveWeightedTopReturn)).filter(Number.isFinite);
    const wfExcess = report.walkForwardEnsembleRows.map((row) => Number(row.netAdaptiveExcessVsBenchmark)).filter(Number.isFinite);
    lines.push(`- Walk-forward 子策略组合（Top${report.ensembleTopK} 子模型，${report.ensembleWeighting} 权重）覆盖 ${report.walkForwardEnsembleRows.length} 个区间：平均净自适应收益 ${pct(mean(wfReturns))}，平均净超大盘 ${pct(mean(wfExcess))}，跑赢大盘命中率 ${pct(mean(wfExcess.map((x) => (x > 0 ? 1 : 0))))}。`);
  }
  if (report.universeFieldAudit?.summary) {
    const audit = report.universeFieldAudit.summary;
    lines.push(`- 当前快照字段审计：评分仍使用 ${audit.usedHighRiskFields.length} 个需要 point-in-time 复核的字段（${audit.usedHighRiskFields.join("、") || "无"}），另有 ${audit.ignoredHighRiskFields.length} 个当前快照字段仅保留为上下文且未进评分；详见 universe_field_audit.csv。`);
  }
  lines.push(`- 这是信号研究回测，不是实盘交易建议；当前股票池来自 ${report.universeSnapshotNote}。`);
  lines.push("- 如果只有一个区间，参数选择存在过拟合风险；建议至少 6-12 个滚动区间做训练/留出。");
  lines.push("");
  lines.push("## 区间结果");
  lines.push("");
  lines.push("| 区间 | 成功评分 | 跳过 | 净自适应 | 毛自适应 | 指数袖珍仓位 | 现金 | 过热现金 | 净推荐收益 | 毛推荐收益 | 净股票池 | 净大盘 | 净超大盘 | 净超股票池 | Top胜率 | p-value |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const p of report.periods) {
    lines.push(`| ${p.period} | ${p.scoredCount} | ${p.skippedCount} | ${pct(p.netAdaptiveWeightedTopReturn)} | ${pct(p.adaptiveWeightedTopReturn)} | ${pct(p.benchmarkOverlayWeight)} | ${pct(p.defensiveCashWeight)} | ${pct(p.exhaustionCashWeight)} | ${pct(p.netWeightedTopReturn)} | ${pct(p.weightedTopReturn)} | ${pct(p.netUniverseMeanReturn)} | ${pct(p.netWeightedBenchmarkReturn)} | ${pct(p.netAdaptiveExcessVsBenchmark)} | ${pct(p.netAdaptiveWeightedExcessReturn)} | ${pct(p.netTopWinRate)} | ${p.pValue || ""} |`);
  }
  lines.push("");
  lines.push("## 数据边界");
  lines.push("");
  for (const caveat of report.caveats) lines.push(`- ${caveat}`);
  lines.push("");
  lines.push(`HTML 可视化：${path.join(report.outDir, "backtest_report.html")}`);
  return lines.join("\n");
}

function buildHtmlReport(report, selectedResults) {
  const chartData = selectedResults.map((result) => ({
    period: `${result.asOf}:${result.end}`,
    top: result.top.map((row) => ({
      code: row.code,
      name: row.name,
      market: row.market,
      score: row.score,
      recommendedWeight: row.recommendedWeight,
      forwardReturn: row.forwardReturn,
      executionCostRate: row.executionCostRate,
      netForwardReturn: row.netForwardReturn,
      benchmarkForwardReturn: row.benchmarkForwardReturn,
      netBenchmarkForwardReturn: row.netBenchmarkForwardReturn,
      entryDate: row.entryDate,
      targetExitDate: row.targetExitDate,
      exitDate: row.exitDate,
      exitDelayDays: row.exitDelayDays,
      exitReason: row.exitReason,
      exitDayReturn: row.exitDayReturn,
      momentumScore: row.momentumScore,
      liquidityScore: row.liquidityScore,
      stabilityScore: row.stabilityScore,
      themeScore: row.themeScore,
      crossSectionScore: row.crossSectionScore,
      trendRankScore: row.trendRankScore,
      accelerationRankScore: row.accelerationRankScore,
      riskRankScore: row.riskRankScore,
      relativeRankScore: row.relativeRankScore,
      relativeMomentumScore: row.relativeMomentumScore,
      industryRankScore: row.industryRankScore,
      industryMomentumScore: row.industryMomentumScore,
      industryResidualMomentumScore: row.industryResidualMomentumScore,
      industryResidualRankScore: row.industryResidualRankScore,
    })),
    deciles: result.deciles,
  }));
  const payload = JSON.stringify({ report, chartData }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Alpha Backtest Report</title>
<style>
:root { color-scheme: light; --ink:#17202a; --muted:#667085; --line:#d9e0e8; --panel:#f7f9fb; --blue:#2563eb; --green:#0f9f6e; --red:#d92d20; --amber:#b7791f; }
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: #fff; }
main { max-width: 1180px; margin: 0 auto; padding: 28px 24px 52px; }
h1 { margin: 0 0 8px; font-size: 30px; line-height: 1.18; letter-spacing: 0; }
h2 { margin: 28px 0 12px; font-size: 18px; letter-spacing: 0; }
p { margin: 6px 0; color: var(--muted); line-height: 1.5; }
.summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 18px 0 20px; }
.metric { border: 1px solid var(--line); border-radius: 8px; padding: 14px; background: var(--panel); min-height: 92px; min-width: 0; }
.metric .label { font-size: 13px; color: var(--muted); }
.metric .value { margin-top: 8px; font-size: clamp(18px, 2vw, 24px); font-weight: 700; overflow-wrap: anywhere; }
.metric .sub { margin-top: 4px; font-size: 12px; color: var(--muted); }
.good { color: var(--green); }
.bad { color: var(--red); }
.warn { color: var(--amber); }
.grid2 { display: grid; grid-template-columns: 1.1fr .9fr; gap: 18px; align-items: start; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { border-bottom: 1px solid var(--line); padding: 8px 7px; text-align: left; vertical-align: middle; }
th { color: #344054; font-weight: 650; background: #f8fafc; position: sticky; top: 0; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.panel { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: #fff; }
.panel-body { padding: 12px; }
.table-wrap { overflow: auto; max-width: 100%; }
.table-wrap.tall { max-height: 560px; }
.compact-table td, .compact-table th { white-space: nowrap; }
.bars { display: grid; gap: 8px; }
.bar-row { display: grid; grid-template-columns: 70px 1fr 72px; gap: 10px; align-items: center; font-size: 12px; }
.bar-track { height: 12px; background: #eef2f7; border-radius: 999px; overflow: hidden; position: relative; }
.bar-fill { height: 100%; min-width: 2px; background: var(--blue); border-radius: 999px; }
.bar-fill.neg { background: var(--red); }
.caveats { padding-left: 18px; color: var(--muted); line-height: 1.55; }
.period-tabs { display: flex; gap: 8px; flex-wrap: wrap; margin: 14px 0; }
.period-tabs button { border: 1px solid var(--line); background: #fff; border-radius: 6px; padding: 7px 10px; cursor: pointer; }
.period-tabs button.active { border-color: var(--blue); color: var(--blue); font-weight: 650; }
@media (max-width: 980px) { .grid2 { grid-template-columns: 1fr; } }
@media (max-width: 640px) { main { padding: 20px 14px 40px; } h1 { font-size: 24px; } .period-tabs button { flex: 1 1 100%; } }
</style>
</head>
<body>
<main>
<h1>Alpha Backtest Report</h1>
<p id="meta"></p>
<section class="summary" id="summary"></section>
<h2>区间选择</h2>
<div class="period-tabs" id="tabs"></div>
<h2>主流指数对比</h2>
<div class="panel">
  <div class="panel-body">
    <div class="table-wrap">
      <table class="compact-table" id="indexTable"></table>
    </div>
  </div>
</div>
<section class="grid2">
  <div class="panel">
    <div class="panel-body">
      <h2 style="margin-top:0">Top${report.topN}</h2>
      <div class="table-wrap tall">
        <table id="topTable"></table>
      </div>
    </div>
  </div>
  <div class="panel">
    <div class="panel-body">
      <h2 style="margin-top:0">分位收益</h2>
      <div class="bars" id="decileBars"></div>
    </div>
  </div>
</section>
<h2>参数网格</h2>
<div class="panel"><div class="panel-body"><div class="table-wrap"><table class="compact-table" id="gridTable"></table></div></div></div>
<h2>Walk-forward</h2>
<div class="panel"><div class="panel-body"><div class="table-wrap"><table class="compact-table" id="walkForwardTable"></table></div></div></div>
<h2>Walk-forward 子策略组合</h2>
<div class="panel"><div class="panel-body"><div class="table-wrap"><table class="compact-table" id="walkForwardEnsembleTable"></table></div></div></div>
<h2>当前快照字段审计</h2>
<div class="panel"><div class="panel-body"><div class="table-wrap"><table class="compact-table" id="universeAuditTable"></table></div></div></div>
<h2>数据边界</h2>
<ul class="caveats" id="caveats"></ul>
</main>
<script>
const DATA = ${payload};
function finiteNumber(value) {
  if (value === "" || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
const fmtPct = (x) => Number.isFinite(x) ? (x * 100).toFixed(2) + "%" : "";
const fmtNum = (x, d = 2) => Number.isFinite(x) ? x.toFixed(d) : "";
let active = DATA.chartData.length - 1;

function cls(x) { return Number.isFinite(x) ? (x >= 0 ? "good" : "bad") : ""; }
function renderSummary() {
  const r = DATA.report.periods[active] || {};
  document.getElementById("meta").textContent = "生成时间 " + DATA.report.generatedAt + " · 参数 " + DATA.report.selectedParam + " · 股票池 " + DATA.report.inputCount + " 只";
  const cards = [
    ["净自适应收益", fmtPct(r.netAdaptiveWeightedTopReturn), "扣交易成本后", cls(r.netAdaptiveWeightedTopReturn)],
    ["净推荐收益", fmtPct(r.netWeightedTopReturn), "Top" + DATA.report.topN + " 加权扣成本", cls(r.netWeightedTopReturn)],
    ["交易成本", fmtPct(r.weightedTopReturn - r.netWeightedTopReturn), "毛推荐收益 " + fmtPct(r.weightedTopReturn), "warn"],
    ["毛自适应收益", fmtPct(r.adaptiveWeightedTopReturn), "Top+指数袖珍仓位", cls(r.adaptiveWeightedTopReturn)],
    ["指数袖珍仓位", fmtPct(r.benchmarkOverlayWeight), "由asOf前指数强度决定", r.benchmarkOverlayWeight ? "warn" : ""],
    ["现金仓位", fmtPct(r.defensiveCashWeight), "弱势 " + fmtPct(r.weakMarketCashWeight) + " · 过热 " + fmtPct(r.exhaustionCashWeight), r.defensiveCashWeight ? "warn" : ""],
    ["净股票池平均", fmtPct(r.netUniverseMeanReturn), "全体已评分扣成本", cls(r.netUniverseMeanReturn)],
    ["净大盘基准", fmtPct(r.netWeightedBenchmarkReturn), "按Top权重映射扣成本", cls(r.netWeightedBenchmarkReturn)],
    ["净自适应超大盘", fmtPct(r.netAdaptiveExcessVsBenchmark), r.significant5pct ? "等权p<0.05" : "等权p=" + (r.pValue || ""), cls(r.netAdaptiveExcessVsBenchmark)],
    ["覆盖率", r.scoredCount + "/" + DATA.report.inputCount, "跳过 " + r.skippedCount + " 只", r.skippedCount ? "warn" : "good"],
  ];
  document.getElementById("summary").innerHTML = cards.map(([label, value, sub, klass]) => '<div class="metric"><div class="label">'+label+'</div><div class="value '+klass+'">'+value+'</div><div class="sub">'+sub+'</div></div>').join("");
}
function renderTabs() {
  document.getElementById("tabs").innerHTML = DATA.chartData.map((p, i) => '<button class="'+(i===active?'active':'')+'" onclick="active='+i+';renderAll()">'+p.period+'</button>').join("");
}
function renderTop() {
  const rows = DATA.chartData[active]?.top || [];
  const head = "<tr><th>Rank</th><th>代码</th><th>名称</th><th class='num'>建议权重</th><th class='num'>评分</th><th class='num'>净收益</th><th class='num'>毛收益</th><th class='num'>交易成本</th><th>目标退出日</th><th>实际退出日</th><th class='num'>退出顺延</th><th class='num'>净对应大盘</th><th class='num'>净超大盘</th><th class='num'>加速Rank</th><th class='num'>相对Rank</th><th class='num'>风险Rank</th><th class='num'>横截面</th></tr>";
  const body = rows.map((row, i) => "<tr><td>"+(i+1)+"</td><td>"+row.code+"</td><td>"+row.name+"</td><td class='num'>"+fmtPct(row.recommendedWeight)+"</td><td class='num'>"+fmtNum(row.score,2)+"</td><td class='num "+cls(row.netForwardReturn)+"'>"+fmtPct(row.netForwardReturn)+"</td><td class='num "+cls(row.forwardReturn)+"'>"+fmtPct(row.forwardReturn)+"</td><td class='num'>"+fmtPct(row.executionCostRate)+"</td><td>"+(row.targetExitDate||"")+"</td><td>"+(row.exitDate||"")+"</td><td class='num "+(row.exitDelayDays ? "warn" : "")+"'>"+(row.exitDelayDays ?? "")+"</td><td class='num'>"+fmtPct(row.netBenchmarkForwardReturn)+"</td><td class='num "+cls(row.netForwardReturn-row.netBenchmarkForwardReturn)+"'>"+fmtPct(row.netForwardReturn-row.netBenchmarkForwardReturn)+"</td><td class='num'>"+fmtNum(row.accelerationRankScore,1)+"</td><td class='num'>"+fmtNum(row.relativeRankScore,1)+"</td><td class='num'>"+fmtNum(row.riskRankScore,1)+"</td><td class='num'>"+fmtNum(row.crossSectionScore,1)+"</td></tr>").join("");
  document.getElementById("topTable").innerHTML = head + body;
}
function renderIndexTable() {
  const period = DATA.chartData[active]?.period;
  const r = DATA.report.periods[active] || {};
  const rows = (DATA.report.mainIndexSummaryRows || []).filter((row) => row.period === period);
  const head = "<tr><th>指数</th><th>代码</th><th class='num'>区间收益</th><th class='num'>净自适应相对超额</th><th class='num'>净推荐相对超额</th><th class='num'>Top等权相对超额</th></tr>";
  const body = rows.map((row) => {
    const ret = finiteNumber(row.return);
    const adaptiveExcess = Number.isFinite(ret) && Number.isFinite(r.netAdaptiveWeightedTopReturn) ? r.netAdaptiveWeightedTopReturn - ret : null;
    const weightedExcess = Number.isFinite(ret) && Number.isFinite(r.netWeightedTopReturn) ? r.netWeightedTopReturn - ret : null;
    const equalExcess = Number.isFinite(ret) && Number.isFinite(r.topMeanReturn) ? r.topMeanReturn - ret : null;
    return "<tr><td>"+row.name+"</td><td>"+row.symbol+"</td><td class='num "+cls(ret)+"'>"+fmtPct(ret)+"</td><td class='num "+cls(adaptiveExcess)+"'>"+fmtPct(adaptiveExcess)+"</td><td class='num "+cls(weightedExcess)+"'>"+fmtPct(weightedExcess)+"</td><td class='num "+cls(equalExcess)+"'>"+fmtPct(equalExcess)+"</td></tr>";
  }).join("");
  document.getElementById("indexTable").innerHTML = head + body;
}
function renderDeciles() {
  const rows = DATA.chartData[active]?.deciles || [];
  const maxAbs = Math.max(0.01, ...rows.map((row) => Math.abs(row.avgReturn || 0)));
  document.getElementById("decileBars").innerHTML = rows.map((row) => {
    const width = Math.max(2, Math.abs(row.avgReturn || 0) / maxAbs * 100);
    const klass = (row.avgReturn || 0) >= 0 ? "" : "neg";
    return '<div class="bar-row"><div>Q'+row.bucket+'</div><div class="bar-track"><div class="bar-fill '+klass+'" style="width:'+width+'%"></div></div><div class="num">'+fmtPct(row.avgReturn)+'</div></div>';
  }).join("");
}
function renderGrid() {
  const rows = DATA.report.optimizationRows || [];
  const head = "<tr><th>参数</th><th>选择模式</th><th class='num'>稳健分</th><th class='num'>训练收益</th><th class='num'>训练加权超额</th><th class='num'>训练命中率</th><th class='num'>留出净超额</th><th class='num'>留出净自适应收益</th><th class='num'>留出毛自适应收益</th><th class='num'>留出净推荐收益</th><th class='num'>留出净大盘</th><th class='num'>区间数</th></tr>";
  const body = rows.map((row) => "<tr><td>"+row.name+"</td><td>"+(row.selectionMode || "")+"</td><td class='num "+cls(row.selectionScore)+"'>"+fmtPct(row.selectionScore)+"</td><td class='num "+cls(row.trainingAvgReturn)+"'>"+fmtPct(row.trainingAvgReturn)+"</td><td class='num "+cls(row.trainingAvgExcess)+"'>"+fmtPct(row.trainingAvgExcess)+"</td><td class='num'>"+fmtPct(row.trainingHitRate)+"</td><td class='num "+cls(row.holdoutNetExcess)+"'>"+fmtPct(row.holdoutNetExcess)+"</td><td class='num "+cls(row.holdoutNetAdaptiveWeightedTopReturn)+"'>"+fmtPct(row.holdoutNetAdaptiveWeightedTopReturn)+"</td><td class='num'>"+fmtPct(row.holdoutAdaptiveWeightedTopReturn)+"</td><td class='num'>"+fmtPct(row.holdoutNetWeightedTopReturn)+"</td><td class='num'>"+fmtPct(row.holdoutNetBenchmarkReturn)+"</td><td class='num'>"+row.periods+"</td></tr>").join("");
  document.getElementById("gridTable").innerHTML = head + body;
}
function renderWalkForward() {
  const rows = DATA.report.walkForwardRows || [];
  const head = "<tr><th>区间</th><th>选择参数</th><th>候选</th><th>incumbent</th><th>原因</th><th>当前门禁</th><th>门禁原因</th><th class='num'>Fresh差</th><th class='num'>20日差</th><th class='num'>相对动量差</th><th class='num'>行业残差差</th><th class='num'>候选优势</th><th class='num'>过滤数</th><th class='num'>训练稳健分</th><th class='num'>训练收益</th><th class='num'>训练超额</th><th class='num'>训练命中率</th><th class='num'>自适应收益</th><th class='num'>指数袖珍仓位</th><th class='num'>现金</th><th class='num'>过热现金</th><th class='num'>自适应超大盘</th><th class='num'>纯Top超大盘</th><th class='num'>p-value</th></tr>";
  const body = rows.map((row) => "<tr><td>"+row.period+"</td><td>"+row.selectedParam+"</td><td>"+(row.candidateParam || "")+"</td><td>"+(row.incumbentParam || "")+"</td><td>"+(row.selectionReason || "")+"</td><td>"+(row.currentGateMode || "")+"</td><td>"+(row.currentGateReason || "")+"</td><td class='num "+cls(row.currentGateFreshTrendAdvantage)+"'>"+fmtNum(row.currentGateFreshTrendAdvantage,2)+"</td><td class='num "+cls(row.currentGateR20Advantage)+"'>"+fmtPct(row.currentGateR20Advantage)+"</td><td class='num "+cls(row.currentGateRelativeMomentumAdvantage)+"'>"+fmtNum(row.currentGateRelativeMomentumAdvantage,2)+"</td><td class='num "+cls(row.currentGateIndustryResidualAdvantage)+"'>"+fmtNum(row.currentGateIndustryResidualAdvantage,2)+"</td><td class='num "+cls(row.candidateScoreAdvantage)+"'>"+fmtPct(row.candidateScoreAdvantage)+"</td><td class='num'>"+(row.filteredParamCount || 0)+"</td><td class='num "+cls(row.trainingScore)+"'>"+fmtPct(row.trainingScore)+"</td><td class='num "+cls(row.trainingAvgReturn)+"'>"+fmtPct(row.trainingAvgReturn)+"</td><td class='num "+cls(row.trainingAvgExcess)+"'>"+fmtPct(row.trainingAvgExcess)+"</td><td class='num'>"+fmtPct(row.trainingHitRate)+"</td><td class='num "+cls(row.adaptiveWeightedTopReturn)+"'>"+fmtPct(row.adaptiveWeightedTopReturn)+"</td><td class='num'>"+fmtPct(row.benchmarkOverlayWeight)+"</td><td class='num'>"+fmtPct(row.defensiveCashWeight)+"</td><td class='num'>"+fmtPct(row.exhaustionCashWeight)+"</td><td class='num "+cls(row.adaptiveExcessVsBenchmark)+"'>"+fmtPct(row.adaptiveExcessVsBenchmark)+"</td><td class='num "+cls(row.weightedExcessVsBenchmark)+"'>"+fmtPct(row.weightedExcessVsBenchmark)+"</td><td class='num'>"+fmtNum(row.pValue,4)+"</td></tr>").join("");
  document.getElementById("walkForwardTable").innerHTML = head + body;
}
function renderWalkForwardEnsemble() {
  const rows = DATA.report.walkForwardEnsembleRows || [];
  const head = "<tr><th>区间</th><th>子策略组合</th><th class='num'>TopK</th><th>权重方式</th><th>原因</th><th class='num'>过滤数</th><th class='num'>训练稳健分</th><th class='num'>训练收益</th><th class='num'>训练超额</th><th class='num'>训练命中率</th><th class='num'>净自适应收益</th><th class='num'>现金</th><th class='num'>过热现金</th><th class='num'>净自适应超大盘</th><th class='num'>净推荐收益</th><th class='num'>净纯Top超大盘</th></tr>";
  const body = rows.map((row) => "<tr><td>"+row.period+"</td><td>"+(row.selectedParams || row.selectedParam || "")+"</td><td class='num'>"+(row.ensembleTopK || "")+"</td><td>"+(row.ensembleWeighting || "")+"</td><td>"+(row.selectionReason || "")+"</td><td class='num'>"+(row.filteredParamCount || 0)+"</td><td class='num "+cls(row.trainingScore)+"'>"+fmtPct(row.trainingScore)+"</td><td class='num "+cls(row.trainingAvgReturn)+"'>"+fmtPct(row.trainingAvgReturn)+"</td><td class='num "+cls(row.trainingAvgExcess)+"'>"+fmtPct(row.trainingAvgExcess)+"</td><td class='num'>"+fmtPct(row.trainingHitRate)+"</td><td class='num "+cls(row.netAdaptiveWeightedTopReturn)+"'>"+fmtPct(row.netAdaptiveWeightedTopReturn)+"</td><td class='num'>"+fmtPct(row.defensiveCashWeight)+"</td><td class='num'>"+fmtPct(row.exhaustionCashWeight)+"</td><td class='num "+cls(row.netAdaptiveExcessVsBenchmark)+"'>"+fmtPct(row.netAdaptiveExcessVsBenchmark)+"</td><td class='num "+cls(row.netWeightedTopReturn)+"'>"+fmtPct(row.netWeightedTopReturn)+"</td><td class='num "+cls(row.netWeightedExcessVsBenchmark)+"'>"+fmtPct(row.netWeightedExcessVsBenchmark)+"</td></tr>").join("");
  document.getElementById("walkForwardEnsembleTable").innerHTML = head + body;
}
function renderUniverseAudit() {
  const rows = DATA.report.universeFieldAudit?.fields || [];
  const head = "<tr><th>字段</th><th>分类</th><th>风险</th><th>评分使用</th><th>PIT要求</th><th>处理动作</th><th class='num'>非空数</th><th>样例</th></tr>";
  const body = rows.map((row) => "<tr><td>"+row.field+"</td><td>"+row.classification+"</td><td class='"+(row.riskLevel === "high" ? "bad" : row.riskLevel === "medium" ? "warn" : "")+"'>"+row.riskLevel+"</td><td>"+(row.usedByScoring ? "是" : "否")+"</td><td>"+(row.requiresPointInTime ? "需要" : "")+"</td><td>"+row.scoringAction+"</td><td class='num'>"+row.nonEmptyCount+"</td><td>"+(row.exampleValues || "")+"</td></tr>").join("");
  document.getElementById("universeAuditTable").innerHTML = head + body;
}
function renderCaveats() {
  document.getElementById("caveats").innerHTML = DATA.report.caveats.map((x) => "<li>"+x+"</li>").join("");
}
function renderAll() { renderSummary(); renderTabs(); renderIndexTable(); renderTop(); renderDeciles(); renderGrid(); renderWalkForward(); renderWalkForwardEnsemble(); renderUniverseAudit(); renderCaveats(); }
renderAll();
</script>
</body>
</html>`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.poolSelectorDirs.length) {
    runPoolSelectorMode(args);
    return;
  }

  const periods = parsePeriods(args.periods);
  const outDir = args.outDir || path.join(DEFAULT_OUTPUT_ROOT, `backtest-${timestamp()}`);
  ensureDir(outDir);
  ensureDir(args.cacheDir);

  const universeSet = loadUniverseSet(args, periods);
  const runUniverses = prepareRunUniverses(args, periods, universeSet);
  const { universeFiles, universeRows, fetchUniverse, periodUniverseRowsByKey, fetchWindowByCode, periodUniverseCounts } = runUniverses;
  const universeFieldAudit = auditUniverseFields(universeRows, {
    asOfRange: periods.map((period) => `${period.asOf}:${period.end}`).join(","),
    snapshotDate: guessUniverseSnapshotDate(universeFiles),
  });
  const minAsOf = minDate(periods.map((p) => p.asOf));
  const maxEnd = maxDate(periods.map((p) => p.end));
  const offlineDirs = args.offlineData || args.offlineOnly
    ? resolveOfflineDataDirs({
      offlineDataDir: args.offlineDataDir,
      qlibDir: args.qlibDir,
      hkConnectHistoryDir: args.hkConnectHistoryDir,
    })
    : null;
  const fetchOpts = {
    cacheDir: args.cacheDir,
    cacheOnly: args.cacheOnly,
    offlineData: args.offlineData,
    offlineOnly: args.offlineOnly,
    offlineDataDir: args.offlineDataDir,
    qlibDir: args.qlibDir,
    hkConnectHistoryDir: args.hkConnectHistoryDir,
    offlineDirs,
    refresh: args.refresh,
    lookback: args.lookback,
    provider: args.provider,
    beg: compactDate(addDays(minAsOf, -Math.max(args.lookback * 2, 260))),
    end: compactDate(addDays(maxEnd, 14)),
    minAsOf,
    maxEnd,
    minHistoryDays: args.minHistory,
  };

  console.log(`[alpha-backtest] universe=${fetchUniverse.length} mode=${runUniverses.mode} files=${universeFiles.join(",")}`);
  console.log(`[alpha-backtest] periods=${periods.map((p) => `${p.asOf}:${p.end}`).join(",")} top=${args.top} provider=${args.provider} cacheOnly=${args.cacheOnly}`);
  if (offlineDirs) {
    console.log(`[alpha-backtest] offlineData qlib=${offlineDirs.qlibDir || "missing"} hk=${offlineDirs.hkConnectHistoryDir || "missing"}`);
  }
  console.log(`[alpha-backtest] out=${outDir}`);

  const fetchResults = await mapLimit(
    fetchUniverse,
    args.concurrency,
    (row) => loadKline(row, { ...fetchOpts, ...(fetchWindowByCode.get(row.code) || {}) }),
    (done, total) => {
      if (done % 50 === 0 || done === total) console.log(`[alpha-backtest] fetched ${done}/${total}`);
    }
  );

  const klineByCode = new Map();
  const klineFailures = [];
  const sourceCounts = {};
  for (const result of fetchResults) {
    if (result.ok) {
      klineByCode.set(result.code, result.kline);
      sourceCounts[result.source] = (sourceCounts[result.source] || 0) + 1;
    } else {
      klineFailures.push({ code: result.code, name: result.name, reason: result.attempts.join(";") });
    }
  }
  writeCsv(path.join(outDir, "kline_fetch_failures.csv"), klineFailures, ["code", "name", "reason"]);

  const { benchmarkKlineBySymbol, benchmarkFailures } = await loadBenchmarkKlines(fetchUniverse, fetchOpts);
  const { byPeriod: benchmarkReturnByPeriod, summaryRows: benchmarkSummaryRows } = buildBenchmarkMapsForPeriodUniverses(
    periods,
    periodUniverseRowsByKey,
    benchmarkKlineBySymbol
  );
  const benchmarkKlineByCode = buildBenchmarkKlineByCode(fetchUniverse, benchmarkKlineBySymbol);
  const mainIndexSummaryRows = buildMainIndexSummaryRows(periods, benchmarkKlineBySymbol);
  writeCsv(path.join(outDir, "benchmark_fetch_failures.csv"), benchmarkFailures, ["symbol", "reason"]);
  console.log(`[alpha-backtest] benchmarks=${benchmarkKlineBySymbol.size} failures=${benchmarkFailures.length}`);

  const params = paramsForRun(args);
  const topNByParamName = new Map(params.map((paramsItem) => [paramsItem.name, paramsItem.topNOverride || args.top]));
  const periodResultsByParam = new Map();
  const optimizationPeriodRows = [];
  for (const paramsItem of params) {
    const results = periods.map((period) => {
      const key = periodKey(period);
      const periodUniverse = periodUniverseRowsByKey.get(key);
      return evaluatePeriod({
        universe: periodUniverse,
        klineByCode,
        asOf: period.asOf,
        end: period.end,
        topN: paramsItem.topNOverride || args.top,
        params: paramsItem,
        benchmarkReturnByCode: benchmarkReturnByPeriod.get(key),
        benchmarkKlineByCode,
      });
    });
    periodResultsByParam.set(paramsItem.name, results);
    for (const result of results) optimizationPeriodRows.push(summarizePeriodResult(result, paramsItem.name));
  }

  const holdoutIndex = periods.length > 1 ? periods.length - 1 : null;
  const optimizationRows = optimizeParams(periodResultsByParam, holdoutIndex).map((row) => ({
    ...row,
    topN: topNByParamName.get(row.name) || args.top,
    selectionScore: round(row.selectionScore, 6),
    trainingAvgReturn: round(row.trainingAvgReturn, 6),
    trainingAvgExcess: round(row.trainingAvgExcess, 6),
    trainingHitRate: round(row.trainingHitRate, 6),
    holdoutExcess: round(row.holdoutExcess, 6),
    holdoutNetExcess: round(row.holdoutNetExcess, 6),
    holdoutTopReturn: round(row.holdoutTopReturn, 6),
    holdoutNetTopReturn: round(row.holdoutNetTopReturn, 6),
    holdoutWeightedTopReturn: round(row.holdoutWeightedTopReturn, 6),
    holdoutNetWeightedTopReturn: round(row.holdoutNetWeightedTopReturn, 6),
    holdoutAdaptiveWeightedTopReturn: round(row.holdoutAdaptiveWeightedTopReturn, 6),
    holdoutNetAdaptiveWeightedTopReturn: round(row.holdoutNetAdaptiveWeightedTopReturn, 6),
    holdoutDefensiveCashWeight: round(row.holdoutDefensiveCashWeight, 6),
    holdoutUniverseReturn: round(row.holdoutUniverseReturn, 6),
    holdoutNetUniverseReturn: round(row.holdoutNetUniverseReturn, 6),
    holdoutBenchmarkReturn: round(row.holdoutBenchmarkReturn, 6),
    holdoutNetBenchmarkReturn: round(row.holdoutNetBenchmarkReturn, 6),
  }));
  const walkForwardOptions = walkForwardOptionsForRun(args, params, periods);
  const walkForwardRows = walkForwardOptimize(periodResultsByParam, walkForwardOptions).map((row) => ({
    ...row,
    selectedTopN: topNByParamName.get(row.selectedParam) || "",
    candidateTrainingScore: round(row.candidateTrainingScore, 6),
    candidateScoreAdvantage: round(row.candidateScoreAdvantage, 6),
    currentGateMode: row.currentGateMode,
    currentGatePassed: row.currentGatePassed,
    currentGateReason: row.currentGateReason,
    currentGateFreshTrendAdvantage: round(row.currentGateFreshTrendAdvantage, 6),
    currentGateR20Advantage: round(row.currentGateR20Advantage, 6),
    currentGateRelativeMomentumAdvantage: round(row.currentGateRelativeMomentumAdvantage, 6),
    currentGateIndustryResidualAdvantage: round(row.currentGateIndustryResidualAdvantage, 6),
    currentGateIndustryResidualRankScore: round(row.currentGateIndustryResidualRankScore, 6),
    trainingScore: round(row.trainingScore, 6),
    trainingAvgReturn: round(row.trainingAvgReturn, 6),
    trainingAvgExcess: round(row.trainingAvgExcess, 6),
    trainingHitRate: round(row.trainingHitRate, 6),
    trainingReturnVol: round(row.trainingReturnVol, 6),
    trainingExcessVol: round(row.trainingExcessVol, 6),
    trainingReturnDownside: round(row.trainingReturnDownside, 6),
    trainingExcessDownside: round(row.trainingExcessDownside, 6),
    trainingWorstReturn: round(row.trainingWorstReturn, 6),
    trainingWorstExcess: round(row.trainingWorstExcess, 6),
    adaptiveWeightedTopReturn: round(row.adaptiveWeightedTopReturn, 6),
    netAdaptiveWeightedTopReturn: round(row.netAdaptiveWeightedTopReturn, 6),
    weightedTopReturn: round(row.weightedTopReturn, 6),
    netWeightedTopReturn: round(row.netWeightedTopReturn, 6),
    topMeanReturn: round(row.topMeanReturn, 6),
    netTopMeanReturn: round(row.netTopMeanReturn, 6),
    universeMeanReturn: round(row.universeMeanReturn, 6),
    netUniverseMeanReturn: round(row.netUniverseMeanReturn, 6),
    weightedBenchmarkReturn: round(row.weightedBenchmarkReturn, 6),
    netWeightedBenchmarkReturn: round(row.netWeightedBenchmarkReturn, 6),
    benchmarkOverlayWeight: round(row.benchmarkOverlayWeight, 6),
    defensiveCashWeight: round(row.defensiveCashWeight, 6),
    weakMarketCashWeight: round(row.weakMarketCashWeight, 6),
    exhaustionCashWeight: round(row.exhaustionCashWeight, 6),
    adaptiveExcessVsBenchmark: round(row.adaptiveExcessVsBenchmark, 6),
    netAdaptiveExcessVsBenchmark: round(row.netAdaptiveExcessVsBenchmark, 6),
    weightedExcessVsBenchmark: round(row.weightedExcessVsBenchmark, 6),
    netWeightedExcessVsBenchmark: round(row.netWeightedExcessVsBenchmark, 6),
    adaptiveWeightedExcessReturn: round(row.adaptiveWeightedExcessReturn, 6),
    netAdaptiveWeightedExcessReturn: round(row.netAdaptiveWeightedExcessReturn, 6),
    pValue: round(row.pValue, 6),
  }));
  const walkForwardEnsembleRows = walkForwardEnsembleOptimize(periodResultsByParam, {
    ...walkForwardOptions,
    topK: args.ensembleTopK,
    weighting: args.ensembleWeighting,
    scoreTemperature: args.ensembleScoreTemperature,
  }).map((row) => ({
    periodIndex: row.periodIndex,
    period: row.period,
    asOf: row.asOf,
    end: row.end,
    selectedParam: row.selectedParam,
    selectedParams: row.selectedParams.join("|"),
    selectedTopN: topNByParamName.get(row.selectedParam) || "",
    selectedTopNs: row.selectedParams.map((name) => topNByParamName.get(name) || "").join("|"),
    candidateParam: row.candidateParam,
    incumbentParam: row.incumbentParam,
    selectionReason: row.selectionReason,
    candidateTrainingScore: round(row.candidateTrainingScore, 6),
    candidateScoreAdvantage: round(row.candidateScoreAdvantage, 6),
    eligibleParamCount: row.eligibleParamCount,
    filteredParamCount: row.filteredParamCount,
    ensembleTopK: row.ensembleTopK,
    ensembleWeighting: row.ensembleWeighting,
    trainingScore: round(row.trainingScore, 6),
    trainingAvgReturn: round(row.trainingAvgReturn, 6),
    trainingAvgExcess: round(row.trainingAvgExcess, 6),
    trainingHitRate: round(row.trainingHitRate, 6),
    trainingPeriods: row.trainingPeriods,
    trainingReturnVol: round(row.trainingReturnVol, 6),
    trainingExcessVol: round(row.trainingExcessVol, 6),
    trainingReturnDownside: round(row.trainingReturnDownside, 6),
    trainingExcessDownside: round(row.trainingExcessDownside, 6),
    trainingWorstReturn: round(row.trainingWorstReturn, 6),
    trainingWorstExcess: round(row.trainingWorstExcess, 6),
    adaptiveWeightedTopReturn: round(row.adaptiveWeightedTopReturn, 6),
    netAdaptiveWeightedTopReturn: round(row.netAdaptiveWeightedTopReturn, 6),
    weightedTopReturn: round(row.weightedTopReturn, 6),
    netWeightedTopReturn: round(row.netWeightedTopReturn, 6),
    topMeanReturn: round(row.topMeanReturn, 6),
    netTopMeanReturn: round(row.netTopMeanReturn, 6),
    universeMeanReturn: round(row.universeMeanReturn, 6),
    netUniverseMeanReturn: round(row.netUniverseMeanReturn, 6),
    weightedBenchmarkReturn: round(row.weightedBenchmarkReturn, 6),
    netWeightedBenchmarkReturn: round(row.netWeightedBenchmarkReturn, 6),
    benchmarkOverlayWeight: round(row.benchmarkOverlayWeight, 6),
    defensiveCashWeight: round(row.defensiveCashWeight, 6),
    weakMarketCashWeight: round(row.weakMarketCashWeight, 6),
    exhaustionCashWeight: round(row.exhaustionCashWeight, 6),
    adaptiveExcessVsBenchmark: round(row.adaptiveExcessVsBenchmark, 6),
    netAdaptiveExcessVsBenchmark: round(row.netAdaptiveExcessVsBenchmark, 6),
    weightedExcessVsBenchmark: round(row.weightedExcessVsBenchmark, 6),
    netWeightedExcessVsBenchmark: round(row.netWeightedExcessVsBenchmark, 6),
    adaptiveWeightedExcessReturn: round(row.adaptiveWeightedExcessReturn, 6),
    netAdaptiveWeightedExcessReturn: round(row.netAdaptiveWeightedExcessReturn, 6),
    scoredCount: row.scoredCount,
    skippedCount: row.skippedCount,
  }));
  const selectedName = optimizationRows[0]?.name || params[0].name;
  const selectedResults = periodResultsByParam.get(selectedName);

  const caveats = [
    "评分阶段只使用 asOf 当日及之前的 K 线；区间收益只在打分完成后用 asOf 到 end 的未来窗口计算。",
    args.universeFilter
      ? "动态股票池过滤只使用 asOf 前已知的 20 日均成交额、价格、波动和可选 ST 标记；本次已开启，用于过滤明显低流动性或价格异常的样本。"
      : "动态股票池过滤本次未开启；如需做流动性/价格/波动率敏感性对照，可用 --universe-filter 或设置 --min-universe-turnover 等阈值显式开启。",
    args.dynamicGroupFilter
      ? `动态行业/主题强度过滤本次已开启：groupBy=${args.dynamicGroupBy}，minSize=${args.minDynamicGroupSize}，minScore=${args.minDynamicGroupScore}，minBreadth20=${args.minDynamicGroupBreadth}，minRemaining=${args.minDynamicGroupRemaining || "TopN"}；它只用 asOf 前的组内 20/60 日趋势、相对强弱和上涨宽度过滤弱组，若过滤后低于覆盖下限会自动回原池，但分组归属仍来自 universe CSV，需要在 universe_field_audit.csv 中复核快照风险。`
      : "动态行业/主题强度过滤本次未开启；如需让宽股票池按 asOf 组强度自动收缩，可用 --dynamic-group-filter 显式开启，并和未开启版本对照。",
    "大盘基准默认按市场映射：主板/普通A股=沪深300，创业板=创业板指，科创板=科创50，港股通=恒生科技，北交所优先北证50、缺数据时退回沪深300。",
    "推荐仓位收益使用 TopN 内部权重归一化，不代表实盘满仓建议；毛收益不扣成本，净收益扣除估算交易成本。",
    "默认净收益已扣除基础 round-trip 成本、流动性缺口滑点和波动率冲击估算；仍未模拟逐笔盘口、涨跌停无法成交、停牌和真实佣金税费差异。",
    "默认可交易性会跳过停牌/零成交和近似封涨停买不到的样本；目标退出日若近似封跌停卖不掉，会在 maxExitDelayDays 内顺延到下一可交易日。这仍是 K 线级近似，不能替代真实盘口和集合竞价可成交量。",
    "自适应组合收益允许在强指数 beta 且 TopN 相对优势不足时配置一部分映射指数袖珍仓位；实验参数还可在 asOf 前基准 20/60 日趋势明显转弱，或 60 日强涨后 20 日动能降速且 TopN 高涨幅高波动时配置现金。两者都不能读取未来收益。",
    args.topValues.length
      ? `TopN 候选本次启用：${args.topValues.join("、")}；每个参数会克隆为 ${args.topValues.map((topN) => `_top${topN}`).join("、")} sleeve，walk-forward 只用历史窗口选择当期 TopN，避免事后按收益挑 TopN。`
      : `TopN 本次固定为 ${args.top}；如需让持仓数量进入训练选择，可使用 --top-values 5,8,10,12,15。`,
    args.ensembleTopK === 1
      ? "Walk-forward 子策略组合每期只用之前区间选择训练稳健分最高的单一参数 sleeve；这是当前默认进攻口径，避免多 sleeve 平均稀释强信号。"
      : args.ensembleWeighting === "score"
        ? `Walk-forward 子策略组合每期只用之前区间训练稳健分选择 Top${args.ensembleTopK} 个参数 sleeve，并用训练稳健分 softmax 温度 ${args.ensembleScoreTemperature} 加权，再合并各 sleeve 的 TopN 持仓；它用于降低单参数 winner-take-all 的选择噪声。`
        : `Walk-forward 子策略组合每期只用之前区间训练稳健分选择 Top${args.ensembleTopK} 个参数 sleeve 等权，再合并各 sleeve 的 TopN 持仓；它用于降低单参数 winner-take-all 的选择噪声。`,
    args.walkForwardStableParam
      ? args.walkForwardIncumbentPolicy === "stable"
        ? `Walk-forward 稳态选参加防噪声控制：生产 incumbent=${args.walkForwardStableParam}，本次使用 stable baseline 口径，每个测试窗口都重新和生产基线比较；challenger 训练稳健分领先不足 ${pct(args.walkForwardSwitchMargin)} 时不切换。`
        : `Walk-forward 稳态选参加防噪声控制：生产 incumbent=${args.walkForwardStableParam}，本次使用 rolling incumbent 口径，切换后的 sleeve 会成为下一期 incumbent；challenger 训练稳健分领先不足 ${pct(args.walkForwardSwitchMargin)} 时不切换。`
      : "Walk-forward 本次未设置生产 incumbent；每期直接按之前区间训练稳健分选择最高参数 sleeve。",
    args.walkForwardMinExploratoryPeriods > 0
      ? `探索参数 warm-up 已开启：rank_ 等复杂探索 sleeve 至少需要 ${args.walkForwardMinExploratoryPeriods} 个历史训练区间后才参与当期竞选；这是防止小样本多参数过拟合的显式约束。`
      : "探索参数 warm-up 本次未开启；rank_ 等复杂 sleeve 可在满足基础训练窗口后立即参与竞选。",
    args.noStaticTheme
      ? "静态主题/行业信号本次已关闭：评分不再读取 universe CSV 的 concepts、relevance、source 和 industry 动量，适合作为当前概念快照穿越的敏感性对照。"
      : "静态主题/行业信号本次仍启用：concepts、relevance、source 和 industry 来自当前 universe CSV，必须通过 universe_field_audit.csv 复核其 point-in-time 风险。",
    "当前实现只接入历史价格、成交额、静态主题字段和横截面排名；财报、公告、研报和历史概念成分尚未做 point-in-time 归档。",
    args.periodUniverseDir
      ? `本次使用 --period-universe-dir=${args.periodUniverseDir}，每个 period 按 pit_universe_<asOf>.csv 读取当期股票池，K 线加载也按单票实际出现窗口校验；这会降低未来股票池成员泄漏，但仍未解决退市幸存者偏差和历史概念/行业成分快照缺失。`
      : "如果 universe CSV 是 2026-06-04 之后构建的股票池，用它回测 2026-04-01 会存在股票池幸存者偏差和概念成分时间穿越风险。",
    args.offlineData
      ? `离线训练数据本次已启用：A股优先读取 Qlib (${offlineDirs?.qlibDir || "missing"})，港股通优先读取 completed-only CSV (${offlineDirs?.hkConnectHistoryDir || "missing"})；若缺失则按本地缓存/联网策略回退。`
      : "离线训练数据本次未启用；K 线按 cache/provider 逻辑加载。",
    "Welch t-test 使用 TopN 与非 Top 样本的均值差近似检验；Top10 样本量很小，p-value 只能作为信号研究证据，不能当作收益保证。",
    periods.length > 1 ? "参数选择使用训练期和最后留出期的稳健分排序；这是算法迭代用的事后调参，下一轮仍需要更多滚动窗口和更新区间验证，不能当作真实样本外收益。" : "只有一个区间时，参数网格比较不能视为真实样本外优化，必须增加滚动区间。",
  ];

  const periodSummaryRows = selectedResults.map((result) => summarizePeriodResult(result, selectedName));
  const report = {
    generatedAt: new Date().toISOString(),
    outDir,
    universeFile: universeFiles.join(","),
    universeFiles,
    universeMode: runUniverses.mode,
    periodUniverseDir: args.periodUniverseDir,
    periodUniverseCounts,
    universeSnapshotNote: universeFiles.map((file) => path.basename(file)).join(","),
    inputCount: fetchUniverse.length,
    fullInputCount: universeRows.length,
    klineOkCount: klineByCode.size,
    klineFailedCount: klineFailures.length,
    sourceCounts,
    offlineData: offlineDirs
      ? {
        enabled: true,
        offlineOnly: args.offlineOnly,
        offlineDataDir: args.offlineDataDir,
        qlibDir: offlineDirs.qlibDir,
        hkConnectHistoryDir: offlineDirs.hkConnectHistoryDir,
      }
      : { enabled: false },
    benchmarkSource: "tencent",
    benchmarkFailures,
    benchmarkSummaryRows,
    mainIndexSummaryRows,
    universeFieldAudit,
    periods: periodSummaryRows,
    topN: selectedResults?.[0]?.topN || args.top,
    requestedTopN: args.top,
    topValues: args.topValues.length ? args.topValues : [args.top],
    ensembleTopK: args.ensembleTopK,
    ensembleWeighting: args.ensembleWeighting,
    ensembleScoreTemperature: args.ensembleScoreTemperature,
    walkForwardStableParam: args.walkForwardStableParam,
    walkForwardSwitchMargin: args.walkForwardSwitchMargin,
    walkForwardIncumbentPolicy: args.walkForwardIncumbentPolicy,
    walkForwardMinExploratoryPeriods: args.walkForwardMinExploratoryPeriods,
    walkForwardKnownOutcomeOnly: args.walkForwardKnownOutcomeOnly,
    selectedParam: selectedName,
    optimizationRows,
    optimizationPeriodRows,
    walkForwardRows,
    walkForwardEnsembleRows,
    fetchOptions: fetchOpts,
    caveats,
  };

  writeResultArtifacts(outDir, selectedName, selectedResults, optimizationRows, {
    ...report,
    walkForwardSelectedResults: walkForwardSelectedResultsForArtifacts(walkForwardRows, periodResultsByParam),
  });
  fs.writeFileSync(path.join(outDir, "BACKTEST_REPORT.md"), buildMarkdownReport(report));
  fs.writeFileSync(path.join(outDir, "backtest_report.html"), buildHtmlReport(report, selectedResults));

  console.log(`[alpha-backtest] selected=${selectedName}`);
  for (const row of periodSummaryRows) {
    console.log(`[alpha-backtest] ${row.period} net_adaptive=${pct(row.netAdaptiveWeightedTopReturn)} gross_adaptive=${pct(row.adaptiveWeightedTopReturn)} cost=${pct(row.weightedTopReturn - row.netWeightedTopReturn)} overlay=${pct(row.benchmarkOverlayWeight)} net_weighted=${pct(row.netWeightedTopReturn)} gross_weighted=${pct(row.weightedTopReturn)} top_eq=${pct(row.topMeanReturn)} net_benchmark=${pct(row.netWeightedBenchmarkReturn)} net_ax_bench=${pct(row.netAdaptiveExcessVsBenchmark)} net_universe=${pct(row.netUniverseMeanReturn)} p=${row.pValue}`);
  }
  if (walkForwardRows.length) {
    console.log(`[alpha-backtest] walk_forward periods=${walkForwardRows.length} avg_net_adaptive=${pct(mean(walkForwardRows.map((row) => Number(row.netAdaptiveWeightedTopReturn))))} avg_net_ax_bench=${pct(mean(walkForwardRows.map((row) => Number(row.netAdaptiveExcessVsBenchmark))))}`);
  }
  if (walkForwardEnsembleRows.length) {
    console.log(`[alpha-backtest] walk_forward_ensemble topK=${args.ensembleTopK} periods=${walkForwardEnsembleRows.length} avg_net_adaptive=${pct(mean(walkForwardEnsembleRows.map((row) => Number(row.netAdaptiveWeightedTopReturn))))} avg_net_ax_bench=${pct(mean(walkForwardEnsembleRows.map((row) => Number(row.netAdaptiveExcessVsBenchmark))))}`);
  }
  console.log(`[alpha-backtest] html=${path.join(outDir, "backtest_report.html")}`);
}

main().catch((error) => {
  console.error(`[alpha-backtest] ERROR ${error.stack || error.message}`);
  process.exit(1);
});
