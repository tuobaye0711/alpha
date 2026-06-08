# Alpha

Alpha 是个人股票助理 skill 和回测运行时的单仓库。它面向 A 股和港股通，目标是在可复核的数据边界内做持仓观察、全量股票池筛选、评分回测、参数迭代和 HTML 可视化报告，辅助寻找风险调整后的超额收益机会。

Alpha 不承诺收益，不执行真实券商交易。涉及自选股和模拟组合时，它只在用户明确授权的任务中调用 MX 能力，并且会区分真实持仓、自选股和模拟组合。

## 中文说明

### 仓库结构

```text
.
├── SKILL.md                 # Codex 消费 alpha skill 的入口
├── README.md                # 中英文说明
├── package.json             # 本地验证命令
├── agents/                  # skill agent 配置
├── references/              # 分析、回测、定时任务、MX 集成规范
└── scripts/                 # 回测、股票池构建、报告和测试脚本
```

这个仓库同时是 GitHub 源码仓库和 Codex skill 根目录。Codex 要能直接消费本 skill，`SKILL.md` 必须位于仓库根目录。

### 数据目录

运行数据不进 Git。默认数据根目录是：

```bash
~/.codex/alpha
```

也可以显式设置：

```bash
export ALPHA_DATA_HOME=/path/to/alpha-data
```

脚本会在数据目录下读取或写入：

```text
$ALPHA_DATA_HOME/cache/kline
$ALPHA_DATA_HOME/cache/offline_datasets
$ALPHA_DATA_HOME/output
```

当前离线训练数据约定：

```text
$ALPHA_DATA_HOME/cache/offline_datasets/qlib_cn_*/qlib_bin
$ALPHA_DATA_HOME/cache/offline_datasets/hk_connect_tencent_*/history_qfq_5y_completed
```

`scripts/lib/offline_data_loader.js` 会自动选择最新的 A 股 Qlib 数据集和港股通 completed CSV 数据集。

### 安装与验证

本仓库没有 npm 运行时依赖，只需要 Node.js。建议 Node.js 20 或更高版本。

```bash
npm run verify
```

验证内容包括：

- 所有 `scripts/**/*.js` 语法检查。
- 回测引擎、CLI 参数、HTML 报告、股票池构建、机会挖掘和离线数据 loader 的 Node 测试。

### 离线回测

优先使用本地离线训练数据：

```bash
node scripts/alpha_backtest.js \
  --universe "$ALPHA_DATA_HOME/output/current-full-alpha-v5-20260608-final/current_full_universe.csv" \
  --period 2026-04-01:2026-06-01 \
  --top 10 \
  --lookback 420 \
  --min-history 65 \
  --offline-data \
  --out-dir "$ALPHA_DATA_HOME/output/backtest-offline-example"
```

完全禁止联网，只使用离线训练数据和本地缓存：

```bash
node scripts/alpha_backtest.js \
  --universe "$ALPHA_DATA_HOME/output/current-full-alpha-v5-20260608-final/current_full_universe.csv" \
  --period 2026-04-01:2026-06-01 \
  --top 10 \
  --lookback 420 \
  --min-history 65 \
  --offline-only \
  --out-dir "$ALPHA_DATA_HOME/output/backtest-offline-only-example"
```

回测产物会包含 `backtest_report.html`、`backtest_summary.json`、`period_summary.csv`、`topN_*.csv`、`scored_*.csv`、`skipped_*.csv`、`kline_fetch_failures.csv` 和主流指数对比 CSV。

### 设计原则

- 评分时点 `asOf` 只能使用当日及以前的数据，未来行情只用于事后评估。
- TopN 等权收益只是对照，正式结论优先看推荐仓位加权收益、扣成本后收益和相对主流指数超额。
- 全量筛选必须保留覆盖率、失败清单和每只股票的结构化评分，不用泛泛主题总结替代逐只分析。
- 算法调优必须保留 holdout、walk-forward 和显著性/反证信息，不能只挑最好看的单区间结果。
- Git 仓库只保存代码和文档，不保存行情缓存、离线数据集和 HTML 输出。

## English

Alpha is a single repository for the personal stock assistant skill and its backtesting runtime. It focuses on A-shares and Hong Kong Stock Connect names, with workflows for portfolio monitoring, exhaustive universe screening, score backtesting, parameter iteration, and HTML reports.

Alpha does not guarantee returns and does not execute real brokerage trades. MX watchlist or simulated portfolio operations are only used when the user explicitly asks for them, and real holdings, watchlists, and simulated portfolios must stay clearly separated.

### Repository Layout

```text
.
├── SKILL.md                 # Entry point consumed by Codex
├── README.md                # Chinese and English documentation
├── package.json             # Local verification commands
├── agents/                  # Skill agent config
├── references/              # Analysis, backtesting, automation, MX integration rules
└── scripts/                 # Backtesting, universe builders, reports, and tests
```

The repository root is also the Codex skill root. Keep `SKILL.md` at the root so Codex can load the skill directly.

### Data Home

Runtime data is intentionally excluded from Git. By default, scripts use:

```bash
~/.codex/alpha
```

Override it with:

```bash
export ALPHA_DATA_HOME=/path/to/alpha-data
```

Scripts read or write:

```text
$ALPHA_DATA_HOME/cache/kline
$ALPHA_DATA_HOME/cache/offline_datasets
$ALPHA_DATA_HOME/output
```

Offline training data is discovered from:

```text
$ALPHA_DATA_HOME/cache/offline_datasets/qlib_cn_*/qlib_bin
$ALPHA_DATA_HOME/cache/offline_datasets/hk_connect_tencent_*/history_qfq_5y_completed
```

`scripts/lib/offline_data_loader.js` automatically picks the latest matching A-share Qlib dataset and Hong Kong Stock Connect completed CSV dataset.

### Verify

This repository has no npm runtime dependencies. Node.js 20 or newer is recommended.

```bash
npm run verify
```

The verification command checks JavaScript syntax and runs the Node test suite for the backtesting engine, CLI behavior, report rendering contracts, universe builders, opportunity mining, and offline data loading.

### Offline Backtesting

Prefer local offline data, with cache/provider fallback:

```bash
node scripts/alpha_backtest.js \
  --universe "$ALPHA_DATA_HOME/output/current-full-alpha-v5-20260608-final/current_full_universe.csv" \
  --period 2026-04-01:2026-06-01 \
  --top 10 \
  --lookback 420 \
  --min-history 65 \
  --offline-data \
  --out-dir "$ALPHA_DATA_HOME/output/backtest-offline-example"
```

Use local-only mode with no network fallback:

```bash
node scripts/alpha_backtest.js \
  --universe "$ALPHA_DATA_HOME/output/current-full-alpha-v5-20260608-final/current_full_universe.csv" \
  --period 2026-04-01:2026-06-01 \
  --top 10 \
  --lookback 420 \
  --min-history 65 \
  --offline-only \
  --out-dir "$ALPHA_DATA_HOME/output/backtest-offline-only-example"
```

Backtest outputs include `backtest_report.html`, `backtest_summary.json`, period summaries, TopN selections, full scored/skipped rows, fetch failures, and mainstream index comparison CSV files.

### Principles

- Scoring at `asOf` can only use data available on or before that date.
- Future price action is only used for post-hoc evaluation.
- Equal-weight TopN returns are diagnostics; production-style reporting prioritizes recommended-weight returns, net returns after costs, and excess returns against mainstream indices.
- Exhaustive screening must preserve coverage, failures, and structured per-stock scores.
- Algorithm tuning must keep holdout, walk-forward, significance, and counter-evidence visible.
- Git stores code and documentation only, not market data caches, offline datasets, or generated reports.
