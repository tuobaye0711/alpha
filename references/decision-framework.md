# Decision Framework

Use this framework when alpha needs to synthesize stock or portfolio advice.

## Verdict Scale

Use a concise verdict:

- `进攻加仓`: evidence is strong, trend/catalyst/fund flow align, and portfolio exposure has room.
- `试仓/小幅加仓`: evidence is improving but confirmation is incomplete; use smaller sizing and clear invalidation.
- `加仓`: evidence is supportive, valuation/risk is acceptable, and portfolio exposure allows it.
- `持有`: thesis intact, no strong reason to change weight.
- `减仓`: risk/reward deteriorated, valuation overheated, thesis weakened, or position risk too high.
- `观察`: evidence is mixed or missing; define triggers.
- `回避`: risk is high, thesis unclear, or data quality is insufficient.

Add confidence: `高 / 中 / 低`.

## Evidence Pillars

Score qualitatively; do not force fake precision.

1. **基本面**：收入、利润、ROE、现金流、资产负债、行业地位。
2. **估值**：PE/PB/PS、历史分位、同业比较、DCF/DDM if applicable.
3. **消息面**：公告、研报、政策、产品/订单/管线/监管事件。
4. **量价与资金**：涨跌幅、成交额、换手、主力/南向资金、均线和区间位置。
5. **组合角色**：仓位、相关性、行业集中度、回撤贡献、目标权重。
6. **反证信号**：哪些事实会让当前判断失效。

## A-Share Notes

- A 股个股研究可复用 `china-stock-analysis` 的数据抓取、财务分析、估值和异常检测。
- 注意涨跌停、T+1、政策敏感行业、财务异常、股权质押、减持、商誉和现金流质量。
- 默认基准可用沪深300；成长/中小盘组合可改用中证500、中证1000或行业指数。

## Hong Kong Notes

- 港股更重视流动性、南向资金、汇率、折价/溢价、公司治理和国际资金风险偏好。
- 创新药、互联网、物业、地产、金融等行业要把政策、融资环境和行业周期纳入结论。
- 默认基准可用恒生指数；科技/互联网组合可用恒生科技指数。

## Portfolio Rules

- 先看组合，再看单票。单票结论必须说明对组合风险和仓位的影响。
- 单只股票建议仓位默认不超过 20%，除非用户已有明确风格偏好。
- 同行业/同因子暴露过高时，优先提示组合集中风险。
- 如果用户问“跑赢大盘”，必须说明比较基准和当前组合暴露是否匹配。
- 每次组合分析必须给出 portfolio stance：`进攻 / 均衡 / 防守`。
- 进攻不是满仓追涨，而是把风险预算集中到证据最强、赔率最好的标的。只要至少一只持仓出现趋势、资金、催化剂和仓位空间共振，就必须列为进攻候选。
- 防守结论必须有证据门槛：组合多数标的破位、关键催化证伪、流动性显著恶化、或仓位集中风险不可接受。不要因为单日下跌就默认防守。
- 如果缺少用户成本、仓位或现金比例，不要因此自动保守；先按“假设等权持仓”给方向，再标注需要补充的数据。

## Offensive Sizing Rules

Use staged sizing so alpha can pursue excess return without binary all-in decisions:

- `+2% to +3%`: thesis improving but needs confirmation.
- `+4% to +6%`: trend/fund flow/catalyst align and downside trigger is clear.
- `+8% or more`: only when the user has stated high risk tolerance or the position is a core high-conviction holding.

When total capital is known, show both percentage and amount. When unknown, show percentage and ask for capital if the user needs money amounts.

For each offensive idea, include:

- Why this name deserves risk budget now.
- Entry style: breakout confirmation, pullback buy, or staged accumulation.
- Stop/invalidation signal.
- What would justify adding more.

## Full-Universe Ranking Rules

When ranking the full market, separate three ideas:

- **Alpha score**: broad composite score for expected excess return after risk.
- **值搏率**: expected upside versus expected downside after liquidity and risk penalties.
- **短期赚钱概率评分**: short-term setup score, not a guaranteed probability unless backed by a validated model.

Require a formula version, for example:

```text
alpha_score_v1 =
  0.20 * liquidity
+ 0.20 * momentum
+ 0.20 * catalyst
+ 0.15 * quality
+ 0.15 * valuation
- 0.10 * risk_penalty
```

For short-term trading, do not let a high momentum score override hard risk flags such as ST, pending delisting, suspension, major fraud signals, or extreme liquidity weakness unless the output explicitly labels the name speculative.

## Trading/Action Discipline

- 分析结论不是自动操作。
- 自选股操作和模拟组合操作可以执行，但必须来自用户明确指令。
- 模拟交易输出必须写明“模拟”。
- 真实交易只提供分析和风险，不执行。

## Short Conclusion Pattern

```text
结论：组合姿态偏进攻，置信度中。当前最值得承担风险的是 X，Y 继续观察，Z 只做风控。
进攻：X 若放量站稳 A，可加 +3% 到 +5%；若回踩 B 不破，可分批试仓。
防守：跌破 C 或消息面证伪则暂停加仓并回撤风险预算。
```
