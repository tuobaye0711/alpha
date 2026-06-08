# Exhaustive Screening

Use this when the user asks for全量股票池、5000多只A股、逐只分析、短期赚钱概率、最高值搏率、不能泛泛筛选, or any high-stakes marketwide ranking.

## Non-Negotiables

- Do not pretend a partial sample is full-market research.
- Do not use `mx-xuangu` alone as the final answer. It can create candidates, but strict mode requires a full universe manifest and per-stock scoring.
- Every stock in the requested universe must have a row in the result set: scored, skipped with reason, or failed with error.
- Persist intermediate artifacts to disk. Do not rely on context memory for thousands of stocks.
- Report coverage, failures, retries, and data freshness.
- If the full run cannot finish in one turn, checkpoint and resume; do not silently reduce scope.

## Universe Definition

Start by freezing the stock pool:

- A 股: all currently listed A shares unless the user excludes ST, B shares, Beijing Stock Exchange, suspended stocks, or new listings.
- 港股: define whether to include all HK common stocks or only liquid/main-board/Stock Connect names. Ask if unclear.
- Save a manifest with `run_id`, `created_at`, `market`, `universe_source`, and one row per security.

Example fields:

```json
{"code":"600519.SH","name":"贵州茅台","market":"A","status":"pending","shard":7}
```

## Strict Pipeline

### 1. Cheap Complete Pass

Run a fast complete pass across every stock to collect comparable fields:

- Price, market cap, turnover, volume, liquidity.
- 1d/5d/20d/60d return and volatility.
- Gap/limit-up/limit-down/suspension flags.
- Basic valuation: PE, PB, PS if available.
- Basic quality: ROE, revenue/profit growth, debt ratio if available.
- Recent catalyst count: announcements/news/research hits when feasible.

This pass must cover the full manifest.

### 2. Standard Per-Stock Score

Every stock gets a standard score record:

```json
{
  "code": "600519.SH",
  "name": "贵州茅台",
  "market": "A",
  "data_time": "2026-06-04T14:40:00+08:00",
  "liquidity_score": 0,
  "momentum_score": 0,
  "catalyst_score": 0,
  "quality_score": 0,
  "valuation_score": 0,
  "risk_penalty": 0,
  "win_probability_score": 0,
  "expected_value_score": 0,
  "alpha_score": 0,
  "verdict": "candidate/neutral/avoid",
  "reasons": [],
  "risks": [],
  "missing_fields": []
}
```

Use a consistent scoring formula for the full run. If the formula changes, restart or version the run.

### 3. Deep Pass

Deep research is expensive. In strict mode, do it in tiers but keep the accounting honest:

- Tier 0: every stock gets the complete standard score.
- Tier 1: top 10-20% by standard score receives deeper news/catalyst and technical review.
- Tier 2: top 1-3% receives full thesis, risk, entry/exit trigger, and position sizing.

If the user explicitly demands every stock receive deep analysis, split the universe into shards and run until every shard produces a deep record. Do not call the final ranking "complete" until coverage is 100% or the failure list is accepted by the user.

## Parallelization

Use multi-agent or parallel execution when available:

- Shard by market and code ranges, not by theme, to avoid selection bias.
- Give every worker the same scoring rubric and output schema.
- Each worker writes JSONL artifacts, not prose summaries.
- The coordinator validates schema, deduplicates codes, retries failures, and aggregates ranking.
- Use a holdout/audit pass: randomly sample lower-ranked stocks and verify they were not unfairly discarded.

Suggested shard sizes:

- Cheap pass: 200-500 stocks per shard.
- Standard pass: 100-250 stocks per shard.
- Deep pass: 20-50 stocks per shard, depending on news depth.

## Scoring For Short-Term Profit Probability

Do not claim true probability unless backed by a tested model. Use "短期赚钱概率评分" as a calibrated heuristic unless a validated backtest exists.

Recommended components:

- Liquidity gate: exclude or penalize low turnover, long suspension, abnormal spreads.
- Momentum/technical: trend strength, volatility, breakout quality, drawdown risk.
- Catalyst: fresh announcements, earnings, policy, industry news, research upgrades.
- Fund flow: northbound/southbound/main funds when available.
- Quality and valuation: avoid pure momentum names with severe fraud/valuation risk unless labeled speculative.
- Risk penalty: ST, pending delisting, major litigation, pledge risk, auditor issues, extreme one-day moves.

Expected value score:

```text
expected_value = upside_probability_score * expected_upside
               - downside_probability_score * expected_downside
               - risk_penalty
```

Always show the formula/version used.

## Final Output

The final answer must include:

- Run id and timestamp.
- Universe size and coverage.
- Success, failed, skipped, and retried counts.
- Scoring formula/version.
- Top candidates table.
- Why the top names beat the next tier.
- Main failure modes and data gaps.
- Artifact paths for full JSONL/CSV results.
- Clear statement if the run is partial.

Top candidate table:

```text
| 排名 | 代码 | 名称 | 市场 | alpha_score | 值搏率 | 短期赚钱概率评分 | 核心理由 | 主要风险 | 触发价/条件 |
|---:|---|---|---|---:|---:|---:|---|---|---|
```

## Stop Conditions

Stop and ask the user only when:

- Universe definition is ambiguous and materially changes the result.
- Required data source credentials are missing and no fallback exists.
- The run would create significant cost/time and the user has not accepted a long-running or resumable workflow.
- A live operation would be triggered. Screening and research are read-only.
