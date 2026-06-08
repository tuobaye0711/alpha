# TradingAgents External Capability

TradingAgents is an external expert-analysis capability for alpha. It is not part of alpha's default decision loop.

## Trigger Policy

Call TradingAgents only when the user explicitly asks for it in the current conversation.

Accepted explicit triggers include:

- `TradingAgents`
- `TA`
- `ta`
- `TauricResearch/TradingAgents`
- `外部专家`
- `外部 TA`
- `用 TA 分析`
- `用外部专家复核`

Do not call TradingAgents for ordinary alpha tasks such as:

- TopN candidate screening
- holding review
- market open / intraday / post-close scheduled tasks
- signal conflict resolution
- high-risk candidate review
- backtesting
- scoring optimization
- model training

Alpha must remain responsible for its own scoring, backtesting, portfolio decisions, and iterative improvement.

## Role

TradingAgents output is an external opinion only.

Required result marker:

```json
{
  "alpha_usage": "external_opinion_only"
}
```

Do not write TradingAgents output into:

- alpha scoring features
- parameter optimization
- backtesting labels
- scheduled task auto-triggers
- portfolio weights
- model training data

If the user later asks alpha to compare or discuss the external opinion, alpha may do so in the current conversation, but this still must not alter the automated scoring model.

## Stable Local Installation

Default stable repository:

```text
$ALPHA_DATA_HOME/tools/TradingAgents
```

When `ALPHA_DATA_HOME` is unset this resolves to:

```text
~/.codex/alpha/tools/TradingAgents
```

Default Python:

```text
~/.codex/alpha/tools/TradingAgents/.venv/bin/python
```

Manual setup:

```bash
mkdir -p ~/.codex/alpha/tools
git clone https://github.com/TauricResearch/TradingAgents.git ~/.codex/alpha/tools/TradingAgents
cd ~/.codex/alpha/tools/TradingAgents
python3.12 -m venv .venv
.venv/bin/python -m pip install -i https://pypi.org/simple .
```

The public PyPI index may be required because some mirrors do not provide the required `yfinance>=1.4.1`.

## Bridge Command

Use the alpha bridge instead of importing TradingAgents directly from ad-hoc scripts:

```bash
python scripts/tradingagents_bridge.py run \
  --symbol 300476.SZ \
  --name 胜宏科技 \
  --market cn-a \
  --date 2026-06-08 \
  --out-dir ~/.codex/alpha/output/tradingagents/manual/2026-06-08/300476.SZ
```

The bridge writes:

```text
request.json
external_opinion.json
external_opinion.html
run.log
```

Every TradingAgents bridge run must generate `external_opinion.html` for visual review. The bridge opens that HTML file in the system default browser by default. Use `--no-open` only for automation, CI, or headless runs where opening a browser would be disruptive.

To render an HTML report from an existing `external_opinion.json` without re-running TradingAgents:

```bash
python scripts/tradingagents_bridge.py render \
  --result ~/.codex/alpha/output/tradingagents/manual/2026-06-08/300476.SZ/external_opinion.json
```

The bridge reads an optional local secrets file before it checks provider credentials:

```text
$ALPHA_DATA_HOME/secrets/tradingagents.env
```

When `ALPHA_DATA_HOME` is unset this resolves to:

```text
~/.codex/alpha/secrets/tradingagents.env
```

For OpenAI-compatible endpoints, store credentials outside the Git repository with mode `600`:

```text
OPENAI_API_KEY=...
TRADINGAGENTS_LLM_PROVIDER=openai
TRADINGAGENTS_BACKEND_URL=https://example.com/v1
TRADINGAGENTS_QUICK_THINK_LLM=provider-model-id
TRADINGAGENTS_DEEP_THINK_LLM=provider-model-id
```

When TradingAgents can run successfully, it also writes raw TradingAgents result files under the configured output directory.

## Failure Handling

If required LLM credentials are unavailable, the bridge must not fabricate an opinion. It should write:

```json
{
  "status": "unavailable",
  "failure_reason": "llm_api_key_missing",
  "alpha_usage": "external_opinion_only"
}
```

Other failure reasons:

- `stable_repo_missing`
- `stable_python_missing`
- `llm_api_key_missing`
- `tradingagents_runtime_error`
- `parse_error`
- `timeout`

Alpha should report the failure briefly and continue its own analysis if the user requested alpha's own view.

## Output Contract

Minimal `external_opinion.json` shape:

```json
{
  "source": "TradingAgents",
  "trigger": "explicit_user_request",
  "alpha_usage": "external_opinion_only",
  "status": "success",
  "symbol": "300476.SZ",
  "mapped_symbol": "300476.SZ",
  "name": "胜宏科技",
  "market": "cn-a",
  "trade_date": "2026-06-08",
  "rating": "Overweight",
  "summary": "...",
  "data_gaps": [],
  "raw_artifacts": {
    "html_report": "...",
    "state_json": "...",
    "run_log": "..."
  }
}
```

If the output conflicts with alpha's own conclusion, report the conflict as a user-visible external-opinion conflict. Do not auto-change alpha's decision.
