# MX Integration

本文件说明 alpha 如何调用东方财富妙想系列 skill。只在需要执行 MX 查询或操作时读取。

## Principles

- 不打印 `MX_APIKEY`，只检查是否存在。
- 默认输出目录使用本机可写路径，例如 `~/.codex/alpha/output`，不要沿用 `/root/.openclaw/workspace/mx_data/output/`。
- 查询尽量具体：证券代码 + 市场 + 时间范围 + 指标名。避免只问“某股票怎么样”。
- 当前行情、新闻和资金面必须以实际查询结果为准；不要用模型记忆补当前数据。
- `mx-zixuan` 是自选股；`mx-moni` 是模拟组合；它们都不代表真实券商持仓。

## Paths

常用本地 skill 路径：

```bash
MX_DATA=/Users/bytedance/.codex/skills/mx-data/mx_data.py
MX_SEARCH=/Users/bytedance/.codex/skills/mx-search/mx_search.py
MX_XUANGU=/Users/bytedance/.codex/skills/mx-xuangu/mx_xuangu.py
MX_ZIXUAN=/Users/bytedance/.codex/skills/mx-zixuan/mx_zixuan.py
MX_MONI=/Users/bytedance/.codex/skills/mx-moni/mx_moni.py
ALPHA_OUTPUT_DIR="${HOME}/.codex/alpha/output"
mkdir -p "$ALPHA_OUTPUT_DIR"
```

Use a working Python runtime in the current environment. If Python startup hangs or dependencies are unavailable, report the blocker and avoid pretending the query succeeded.

## Data Queries

Use `mx-data` for行情、财务、估值、股东、经营和关系数据。

Examples:

```bash
python "$MX_DATA" "贵州茅台600519.SH今日收盘价、涨跌幅、成交额、主力资金流向" "$ALPHA_OUTPUT_DIR"
python "$MX_DATA" "康方生物09926.HK今日最新价、涨跌幅、成交额、南向资金持股变化" "$ALPHA_OUTPUT_DIR"
python "$MX_DATA" "宁德时代300750.SZ近三年营业收入、净利润、ROE、资产负债率" "$ALPHA_OUTPUT_DIR"
```

Read terminal preview first. If needed, inspect generated raw JSON or Excel files in `ALPHA_OUTPUT_DIR`.

## News And Events

Use `mx-search` for新闻、公告、研报、政策、机构观点、南向资金解读 and event attribution.

Examples:

```bash
python "$MX_SEARCH" "康方生物09926.HK 最近公告 研报 机构观点 股价影响" "$ALPHA_OUTPUT_DIR"
python "$MX_SEARCH" "今日港股创新药板块上涨原因 南向资金 研报" "$ALPHA_OUTPUT_DIR"
python "$MX_SEARCH" "贵州茅台 最近公告 研报 分红 股东大会" "$ALPHA_OUTPUT_DIR"
```

When summarizing, separate hard facts from analyst opinion.

## Screening

Use `mx-xuangu` for natural-language candidate generation.

Examples:

```bash
python "$MX_XUANGU" --query "A股 ROE大于15% 市盈率小于20 近一年净利润增长为正" --output-dir "$ALPHA_OUTPUT_DIR"
python "$MX_XUANGU" --query "港股 通信设备 最近20日涨幅居前 成交额放大" --output-dir "$ALPHA_OUTPUT_DIR"
```

Do not treat screening results as recommendations. Re-rank candidates with alpha's decision framework.

## Self-Select Watchlist

Use `mx-zixuan` for 东方财富自选股.

```bash
python "$MX_ZIXUAN" query --output-dir "$ALPHA_OUTPUT_DIR"
python "$MX_ZIXUAN" add "600519" --output-dir "$ALPHA_OUTPUT_DIR"
python "$MX_ZIXUAN" delete "600519" --output-dir "$ALPHA_OUTPUT_DIR"
```

Execute add/delete only when the user clearly asks. If a name can match multiple securities, ask for code.

## Mock Portfolio

`mx-moni` supports simulated positions, balance, orders, mock buy/sell/cancel, and posts. Because the script uses a fixed default output directory, prefer direct API calls or capture terminal output if the script cannot write locally.

Read-only examples:

```bash
python "$MX_MONI" "我的持仓"
python "$MX_MONI" "我的资金"
python "$MX_MONI" "我的委托"
```

Direct read-only API examples:

```bash
curl -s -X POST "${MX_API_URL:-https://mkapi2.dfcfs.com/finskillshub}/api/claw/mockTrading/positions" \
  -H "apikey: ${MX_APIKEY}" \
  -H "Content-Type: application/json" \
  -d '{"moneyUnit":1}'

curl -s -X POST "${MX_API_URL:-https://mkapi2.dfcfs.com/finskillshub}/api/claw/mockTrading/balance" \
  -H "apikey: ${MX_APIKEY}" \
  -H "Content-Type: application/json" \
  -d '{"moneyUnit":1}'
```

Action examples, only after explicit user intent:

```bash
python "$MX_MONI" "模拟买入 600519 100 股 市价"
python "$MX_MONI" "模拟卖出 600519 100 股 价格 1700"
python "$MX_MONI" "撤销所有未成交订单"
```

Direct mock trade API shape:

```bash
curl -s -X POST "${MX_API_URL:-https://mkapi2.dfcfs.com/finskillshub}/api/claw/mockTrading/trade" \
  -H "apikey: ${MX_APIKEY}" \
  -H "Content-Type: application/json; charset=UTF-8" \
  -d '{"type":"buy","stockCode":"600519","quantity":100,"useMarketPrice":true}'
```

For mock trading, require:

- Clear simulated context.
- Stock code.
- Buy/sell/cancel direction.
- Quantity for buy/sell.
- Price or explicit market-price instruction.

After execution, report success/failure, order id if any, and the resulting risk or next check.

## Failure Handling

- Missing `MX_APIKEY`: ask user to configure it or use non-MX fallback if available.
- Rate limit: say the query hit daily quota; avoid repeated retries.
- Empty result: tighten query with code, market, date, and concrete indicators.
- Network failure: retry once if useful; otherwise report the failure and continue with available evidence.
- Large output: narrow time range and metrics.
