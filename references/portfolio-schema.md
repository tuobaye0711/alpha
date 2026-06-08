# Portfolio Schema

Alpha can accept holdings through conversation. If the user wants persistence or repeatedly asks alpha to track the same portfolio, store a local non-secret record under:

```text
~/.codex/alpha/portfolio.yaml
```

Create parent directories as needed. Do not store API keys or broker credentials.

## Source Types

Use `source` to avoid mixing portfolio concepts:

- `manual`: user-provided real holding or strategy record.
- `mx-zixuan`: 东方财富自选股 watchlist, not real holdings.
- `mx-moni`: 东方财富模拟组合, not real trading.
- `derived`: temporary list derived from screening or research.

## Minimal YAML

```yaml
version: 1
base_currency: CNY
total_strategy_capital: 300000
default_benchmark:
  A: 000300.SH
  HK: HSI.HK
positions:
  - code: 600519.SH
    name: 贵州茅台
    market: A
    source: manual
    quantity: 100
    cost_price: 1700
    target_weight: 0.12
    thesis: 高质量消费龙头，现金流稳定，估值回落后进入观察区
    invalidation: 高端白酒需求持续走弱或渠道价格体系失守
    watch:
      - 批价
      - 分红
      - 季报收入增速
  - code: 09926.HK
    name: 康方生物
    market: HK
    source: manual
    cost_amount: 30000
    target_weight: 0.10
    thesis: 创新药管线兑现与海外授权可能带来重估
    invalidation: 核心管线数据不达预期或商业化进度显著低于预期
```

## Field Guidance

Required for persistent records:

- `code`: use suffix when known, such as `600519.SH`, `300750.SZ`, `09926.HK`.
- `name`: Chinese short name.
- `market`: `A` or `HK`.
- `source`: `manual`, `mx-zixuan`, `mx-moni`, or `derived`.

Useful optional fields:

- `quantity`, `cost_price`, `cost_amount`: use whichever the user gives.
- `target_weight`: desired portfolio weight as decimal.
- `thesis`: why the position exists.
- `invalidation`: what would prove the thesis wrong.
- `watch`: concrete variables to monitor.
- `notes`: free-form notes.

## Update Rules

- If the user provides holdings in dialogue and says to track, update the local record.
- If the user only asks a one-off question, keep the data in the response context; do not persist unless useful or requested.
- If cost, quantity, or market is missing, ask only for the missing field needed for the current analysis.
- If the same code appears in multiple sources, show them separately unless the user asks to merge.

## Amount Output

When `total_strategy_capital` is known, translate position advice into both percentage and money:

```text
建议加仓 +4% / 1.20万，目标仓位从 8% 到 12%。
```

When it is unknown, give percentage or ask for total capital if the user asks “买多少/卖多少/入手多少”.
