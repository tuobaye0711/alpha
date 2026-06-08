#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { defaultOutputRoot } = require("./lib/paths");

const outputRoot = defaultOutputRoot();
const input =
  process.argv[2] ||
  path.join(outputRoot, "physical-ai-deep-review-20260604-1800", "deep_review_top100.jsonl");
const outDir =
  process.argv[3] ||
  path.join(outputRoot, "physical-ai-trade-plan-20260604-1815");

const runId = path.basename(outDir);
const dataTime = new Date().toISOString();
const headers = {
  "user-agent": "Mozilla/5.0",
  referer: "https://quote.eastmoney.com/",
};

fs.mkdirSync(outDir, { recursive: true });

function n(value, fallback = null) {
  if (value == null || value === "" || value === "-") return fallback;
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
}

function round(value, digits = 2) {
  const x = n(value);
  if (x == null) return "";
  return Number(x.toFixed(digits));
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function csvEscape(value) {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(file, rows, cols) {
  fs.writeFileSync(
    path.join(outDir, file),
    [cols.join(","), ...rows.map((row) => cols.map((c) => csvEscape(row[c])).join(","))].join("\n")
  );
}

function marketPrefix(row) {
  const code = row.code;
  if (row.market === "港股通" || /^\d{5}$/.test(code)) return `hk${code}`;
  if (/^(6|688|689)/.test(code)) return `sh${code}`;
  return `sz${code}`;
}

async function fetchKline(symbol) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,180,qfq`;
  const res = await fetch(url, { headers });
  const text = await res.text();
  if (!text || !text.startsWith("{")) throw new Error(`non-json kline response: ${text.slice(0, 60)}`);
  const json = JSON.parse(text);
  const item = json.data?.[symbol];
  if (!item) throw new Error("missing symbol data");
  const rows = item.qfqday || item.day || item.hfqday || [];
  return rows
    .map((r) => ({
      date: r[0],
      open: Number(r[1]),
      close: Number(r[2]),
      high: Number(r[3]),
      low: Number(r[4]),
      volume: Number(r[5]),
    }))
    .filter((r) => Number.isFinite(r.close) && Number.isFinite(r.high) && Number.isFinite(r.low));
}

function avg(values) {
  const xs = values.filter((x) => Number.isFinite(x));
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}

function technical(kline) {
  if (!kline.length) return {};
  const last = kline[kline.length - 1];
  const closes = kline.map((r) => r.close);
  const ma = (days) => avg(closes.slice(-days));
  const slice20 = kline.slice(-20);
  const slice60 = kline.slice(-60);
  const high20 = Math.max(...slice20.map((r) => r.high));
  const low20 = Math.min(...slice20.map((r) => r.low));
  const high60 = Math.max(...slice60.map((r) => r.high));
  const low60 = Math.min(...slice60.map((r) => r.low));
  const trs = [];
  for (let i = Math.max(1, kline.length - 20); i < kline.length; i += 1) {
    const cur = kline[i];
    const prev = kline[i - 1];
    trs.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close)));
  }
  const atr20 = avg(trs);
  const ma20 = ma(20);
  const ma60 = ma(60);
  const distMa20 = ma20 ? ((last.close / ma20) - 1) * 100 : null;
  const distHigh20 = high20 ? ((last.close / high20) - 1) * 100 : null;
  return {
    date: last.date,
    close: last.close,
    ma5: ma(5),
    ma10: ma(10),
    ma20,
    ma60,
    high20,
    low20,
    high60,
    low60,
    atr20,
    dist_ma20: distMa20,
    dist_high20: distHigh20,
  };
}

function readAgentQc() {
  const files = [
    "agent_trade_qc_execution_chain.jsonl",
    "agent_trade_qc_edge_ai.jsonl",
    "agent_trade_qc_hk_sensing.jsonl",
  ];
  const map = new Map();
  for (const file of files) {
    const p = path.join(outDir, file);
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, "utf8").split(/\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (item.code) map.set(item.code, item);
      } catch {}
    }
  }
  return map;
}

function classifyPlan(row, tech, qc) {
  const score = n(row.deep_expected_value_score_final, 0);
  const valueBet = n(row.deep_value_bet_score, 0);
  const shortMid = n(row.deep_short_mid_score, 0);
  const risk = row.key_risk || "";
  const close = n(tech.close, n(row.price));
  const ma20 = n(tech.ma20);
  const high20 = n(tech.high20);
  const low20 = n(tech.low20);
  const atr = n(tech.atr20, close ? close * 0.035 : null);
  const distMa20 = n(tech.dist_ma20, 0);
  const qcRole = qc?.role || "";
  const qcTradeBias = qc?.trade_bias || "";

  let conviction = "中";
  if (score >= 78 && valueBet >= 73 && !/经营现金流为负|PE极高|PB极高|资产负债率/.test(risk)) conviction = "高";
  if (score < 75 || /经营现金流为负|PE极高|PB极高|净利同比-/.test(risk)) conviction = "中低";
  if (qc?.conviction === "高") conviction = "高";
  if (qc?.conviction === "中") conviction = conviction === "高" ? "中" : conviction;
  if (qc?.conviction === "低") conviction = "中低";

  let role = "弹性进攻";
  if (/核心进攻/.test(qcRole)) role = "核心进攻";
  if (/弹性进攻/.test(qcRole)) role = "弹性进攻";
  if (/观察/.test(qcRole) || score < 75) role = "观察等待";
  if (/剔除/.test(qcRole)) role = "观察等待";
  if (conviction === "高" && score >= 77) role = "核心进攻";
  if (/弹性进攻/.test(qcRole)) role = "弹性进攻";
  if (/港股通/.test(row.market) && row.missing_fields?.includes("hk_finance")) role = "弹性进攻";

  let tradeBias = "回踩买";
  if (close && ma20 && close < ma20) tradeBias = "突破买";
  if (distMa20 != null && distMa20 > 10) tradeBias = "回踩买";
  if (distMa20 != null && distMa20 >= -3 && distMa20 <= 6) tradeBias = "分批试仓";
  if (/突破买|回踩买|只观察|回避/.test(qcTradeBias)) tradeBias = qcTradeBias;
  if (/观察等待/.test(role) && !/突破买|回踩买/.test(qcTradeBias)) tradeBias = "只观察";

  let firstBuyLow = close;
  let firstBuyHigh = close;
  if (tradeBias === "突破买") {
    firstBuyLow = ma20 || close;
    firstBuyHigh = (ma20 || close) * 1.025;
  } else if (tradeBias === "回踩买") {
    firstBuyLow = Math.max(low20 || close * 0.9, (ma20 || close) * 0.98);
    firstBuyHigh = (ma20 || close) * 1.03;
  } else {
    firstBuyLow = close * 0.98;
    firstBuyHigh = close * 1.01;
  }
  const addTrigger = high20 ? high20 * 1.01 : close * 1.04;
  const stopLoss = Math.min((ma20 || close) * 0.93, close - (atr || close * 0.035) * 1.8);
  const hardInvalidation = Math.min(low20 || stopLoss, stopLoss);

  let position = "1%-2%观察仓";
  if (role === "核心进攻" && conviction === "高") position = "3%-5%，突破确认后最高6%";
  else if (role === "核心进攻") position = "2%-4%，确认后最高5%";
  else if (role === "弹性进攻") position = "2%-3%，确认后最高4%";
  if (/PE极高|PB极高|经营现金流为负|资产负债率/.test(risk)) position = "1%-2%，只做试错仓";
  if (tradeBias === "只观察" || tradeBias === "回避") position = "0%，等证据补齐";

  return {
    conviction,
    role,
    trade_bias: tradeBias,
    first_buy_zone: close ? `${round(firstBuyLow)}-${round(firstBuyHigh)}` : "",
    add_trigger: close ? `放量站稳 ${round(addTrigger)} 上方` : "",
    stop_loss: close ? `${round(stopLoss)}；硬失效 ${round(hardInvalidation)}` : "",
    position_sizing: position,
    invalidation: [
      `跌破20日线后3日不能收回`,
      row.key_risk || "",
      qc?.main_risk || "",
    ].filter(Boolean).join("；"),
    must_verify_before_buy: qc?.must_verify_before_buy || row.must_verify_next || "物理AI相关收入/订单占比",
    score_note: `深复核${score}，值搏率${valueBet}，短中期${shortMid}`,
  };
}

function md(value) {
  return String(value || "-").replace(/\|/g, "；").replace(/\n/g, " ");
}

function writeReport(rows) {
  const table = rows.map((row) =>
    `| ${row.priority_rank} | ${row.code} | ${row.name} | ${row.role} | ${row.conviction} | ${row.trade_bias} | ${row.first_buy_zone} | ${row.add_trigger} | ${row.stop_loss} | ${row.position_sizing} | ${md(row.key_risk || row.qc_main_risk)} |`
  );
  const text = [
    "# Alpha 物理 AI 第三步交易计划",
    "",
    "生成时间：2026-06-04 Asia/Shanghai",
    "",
    "## 短结论",
    "",
    "11 只深研优先B已生成交易计划。当前不建议无脑追高，优先采用“回踩/突破确认 + 小仓试错 + 证据补齐后加仓”的方式。",
    "",
    "当前最值得优先跟踪的进攻组：全志科技、雷赛智能、中科创达、双环传动、埃斯顿、汇川技术、三花智控。",
    "",
    "舜宇光学科技属于港股感知核心，但本地港股财务缺口较大，需要补港交所/公司公告后再定仓位。",
    "",
    "## 交易计划表",
    "",
    "| 优先级 | 代码 | 名称 | 组合角色 | 置信度 | 买入方式 | 第一买入区 | 加仓触发 | 止损/失效 | 建议仓位 | 主要风险 |",
    "|---:|---|---|---|---|---|---|---|---|---|---|",
    ...table,
    "",
    "## 执行纪律",
    "",
    "- 只在触发价/区间出现时执行，不在单日急涨后追价。",
    "- 任何一只个股未确认物理 AI 订单/收入穿透前，默认不超过 5%。",
    "- PE/PB 极高或现金流为负的标的，只允许试错仓，不允许直接核心仓。",
    "- 同属执行控制链的个股不能全部重仓，避免同一主题回撤叠加。",
    "",
    "## 数据边界",
    "",
    "- 技术位来自腾讯 180 日前复权 K 线，行情时间以接口返回最新交易日为准。",
    "- 深复核财务和公告沿用第二步东方财富 F10/公告结果。",
    "- 这不是自动交易指令；真实交易前需要确认账户总资金、已有仓位、可承受回撤和当日盘口。",
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "TRADE_PLAN_REPORT.md"), text);
}

async function main() {
  const all = fs.readFileSync(input, "utf8").trim().split(/\n/).filter(Boolean).map(JSON.parse);
  const targets = all
    .filter((row) => row.deep_verdict_final === "深研优先B")
    .sort((a, b) => n(a.deep_rank, 999) - n(b.deep_rank, 999));
  const qcMap = readAgentQc();
  const rows = [];
  for (const row of targets) {
    let kline = [];
    let klineError = "";
    try {
      kline = await fetchKline(marketPrefix(row));
    } catch (err) {
      klineError = err.message || String(err);
    }
    const tech = technical(kline);
    const qc = qcMap.get(row.code);
    const plan = classifyPlan(row, tech, qc);
    rows.push({
      run_id: runId,
      data_time: dataTime,
      priority_rank: rows.length + 1,
      deep_rank: row.deep_rank,
      review_rank: row.review_rank,
      code: row.code,
      name: row.name,
      market: row.market,
      physical_ai_chain: row.physical_ai_chain,
      deep_score: row.deep_expected_value_score_final,
      value_bet_score: row.deep_value_bet_score,
      short_mid_score: row.deep_short_mid_score,
      conviction: plan.conviction,
      role: plan.role,
      trade_bias: plan.trade_bias,
      first_buy_zone: plan.first_buy_zone,
      add_trigger: plan.add_trigger,
      stop_loss: plan.stop_loss,
      position_sizing: plan.position_sizing,
      invalidation: plan.invalidation,
      must_verify_before_buy: plan.must_verify_before_buy,
      close: round(tech.close ?? row.price),
      kline_date: tech.date || "",
      ma5: round(tech.ma5),
      ma10: round(tech.ma10),
      ma20: round(tech.ma20),
      ma60: round(tech.ma60),
      high20: round(tech.high20),
      low20: round(tech.low20),
      high60: round(tech.high60),
      low60: round(tech.low60),
      atr20: round(tech.atr20),
      dist_ma20: round(tech.dist_ma20),
      key_positive: row.key_positive,
      key_risk: row.key_risk,
      qc_conviction: qc?.conviction || "",
      qc_role: qc?.role || "",
      qc_order_revenue_evidence: qc?.order_revenue_evidence || "",
      qc_main_risk: qc?.main_risk || "",
      qc_trade_bias: qc?.trade_bias || "",
      kline_error: klineError,
      source: `${row.source}|tencent_kline_trade_plan|agent_trade_qc`,
    });
  }
  const cols = [
    "priority_rank",
    "deep_rank",
    "review_rank",
    "code",
    "name",
    "market",
    "physical_ai_chain",
    "deep_score",
    "value_bet_score",
    "short_mid_score",
    "conviction",
    "role",
    "trade_bias",
    "first_buy_zone",
    "add_trigger",
    "stop_loss",
    "position_sizing",
    "invalidation",
    "must_verify_before_buy",
    "close",
    "kline_date",
    "ma5",
    "ma10",
    "ma20",
    "ma60",
    "high20",
    "low20",
    "high60",
    "low60",
    "atr20",
    "dist_ma20",
    "key_positive",
    "key_risk",
    "qc_conviction",
    "qc_role",
    "qc_order_revenue_evidence",
    "qc_main_risk",
    "qc_trade_bias",
    "kline_error",
    "source",
  ];
  writeCsv("trade_plan_priority11.csv", rows, cols);
  fs.writeFileSync(path.join(outDir, "trade_plan_priority11.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  fs.writeFileSync(path.join(outDir, "trade_plan_summary.json"), JSON.stringify({
    run_id: runId,
    data_time: dataTime,
    input,
    reviewed: rows.length,
    codes: rows.map((row) => `${row.code} ${row.name}`),
    kline_errors: rows.filter((row) => row.kline_error).map((row) => ({ code: row.code, name: row.name, error: row.kline_error })),
  }, null, 2));
  writeReport(rows);
  console.log(JSON.stringify({
    out_dir: outDir,
    reviewed: rows.length,
    kline_errors: rows.filter((row) => row.kline_error).length,
    top: rows.slice(0, 5).map((row) => `${row.code} ${row.name} ${row.trade_bias} ${row.first_buy_zone}`),
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
