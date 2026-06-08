# Scheduled Tasks

Alpha supports weekday scheduled analysis for A-share and Hong Kong stock workflows. Read this when the user asks for盘前、盘中、尾盘、盘后、定时任务、自动发送、提醒、watch, or recurring analysis.

## Default Schedule

Use Asia/Shanghai time unless the user says otherwise.

- **盘前 08:45**：检查隔夜外盘、宏观/政策、公告研报、重点持仓新闻、今日风险日历，输出当天计划和风险优先级。
- **开盘后 10:15**：检查开盘强弱、量价确认、板块轮动、异常跳空，判断是否需要等待、撤销计划或提前防守。
- **午盘 12:30**：复核上午走势，更新组合风险、资金流和下午观察点。
- **操作前 14:40**：给用户尾盘前操作信号。若用户常在 14:45 左右操作，优先保留 14:40。
- **A 股收盘后 15:20**：复盘 A 股持仓、交易计划执行情况、次日观察点。
- **港股收盘后 16:20**：复盘港股持仓、南向资金、重要公告和次日风险。

Default to weekdays. If a market calendar is available, skip exchange holidays; otherwise state that the task is weekday-based and may run on holidays.

## Task Design

Each scheduled task must define:

- Scope: portfolio, watchlist, selected strategy, A-share universe, Hong Kong stocks, or specific names.
- Source: manual portfolio, `mx-zixuan`, `mx-moni`, local file, or temporary list.
- Purpose: risk alert, trade-before signal, news digest, full review, or screening run.
- Output channel: Codex notification/thread by default; ask if the user wants Feishu, email, file, or another channel.
- Evidence depth: lightweight daily check or deep research.
- Success criteria: report delivered, data timestamp shown, failures listed.
- Offensive requirement: every scheduled portfolio report must include `进攻候选`, `加仓/试仓触发`, and `不该追的标的`. If no offensive candidate exists, explicitly explain why the whole portfolio should stay defensive.

## Automation Tool Rule

When the user asks to actually create/update/delete a recurring task in Codex, use the Codex automation tool if available. Do not write raw automation directives or hidden cron-like instructions by hand.

Use a detached cron automation for recurring workspace jobs. The automation prompt must be self-sufficient and include:

- Use `$alpha`.
- The exact scope and portfolio/watchlist source.
- The time window's purpose.
- Required output sections.
- Data source priorities and fallback behavior.
- "Do not execute real trades."

If the automation needs local setup files, propose/suggest the automation rather than mutating immediately when the platform requires review.

## macOS Fallback

If Codex automation is unavailable and the user asks for a local scheduler, use macOS `launchd` carefully:

- Put runtime scripts/config/logs/reports in `~/Library/Application Support/CodexStockWatch/` or an alpha-specific sibling directory.
- Avoid passing paths with spaces through `zsh -lc`; execute script paths directly.
- Verify with `launchctl print gui/$(id -u)/<label>`.
- Treat it as successful only when `last exit code = 0` and report/log timestamps update.
- Keep generated reports under a stable local directory and tell the user the path.

## Report Shape By Time Window

### 盘前

- Today's conclusion: offensive/defensive/observe.
- Overnight events and policy/news catalysts.
- Offensive candidates and planned trigger conditions.
- Position-level risk and action candidates.
- Data gaps and market-open checks.

### 盘中 / 10:15 / 午盘

- Price/volume confirmation.
- Sector and index relative strength.
- Whether original plan still holds.
- Which position deserves more risk if confirmation improves.
- Alerts that require waiting or reducing risk.

### 操作前 / 14:40

- Short conclusion first.
- Buy/add, trial add, sell/reduce, no-action list.
- Rank offensive candidates before defensive notes unless the portfolio is explicitly defensive.
- Position percentage and amount if `total_strategy_capital` is known.
- Clear invalidation and next check.

### 盘后

- What changed today.
- Which signals worked/failed.
- Tomorrow's offensive watchlist and add triggers.
- Portfolio contribution and drawdown risk.
- Tomorrow's watchlist and triggers.

## Deduplication

Before creating a new task, inspect existing automations if possible. Prefer updating an existing alpha task over creating a duplicate with the same purpose and schedule.
