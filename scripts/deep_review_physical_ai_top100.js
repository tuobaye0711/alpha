#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { defaultOutputRoot } = require("./lib/paths");

const outputRoot = defaultOutputRoot();
const input =
  process.argv[2] ||
  path.join(outputRoot, "physical-ai-score-20260604-1745", "physical_ai_reviewed_top100.csv");
const outDir =
  process.argv[3] ||
  path.join(outputRoot, "physical-ai-deep-review-20260604-1800");

const runId = path.basename(outDir);
const dataTime = new Date().toISOString();
const today = process.env.ALPHA_TODAY || "2026-06-04";
const beginDate = process.env.ALPHA_BEGIN_DATE || "2025-12-01";
const eastmoneyF10Token = process.env.ALPHA_EASTMONEY_F10_TOKEN || "";
const headers = {
  "user-agent": "Mozilla/5.0",
  referer: "https://data.eastmoney.com/",
};

fs.mkdirSync(outDir, { recursive: true });

function parseCsvLine(line) {
  const cells = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') {
      if (line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (c === "," && !quoted) {
      cells.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  return cells;
}

function parseCsv(text) {
  const lines = text.trim().split(/\n/).filter(Boolean);
  const cols = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const row = {};
    cols.forEach((col, i) => {
      row[col] = cells[i] ?? "";
    });
    return row;
  });
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

function n(value, fallback = null) {
  if (value == null || value === "" || value === "-") return fallback;
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
}

function clamp(x, lo = 0, hi = 100) {
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function scoreLinear(x, low, high, lowScore = 20, highScore = 90) {
  if (x == null) return 45;
  if (x <= low) return lowScore;
  if (x >= high) return highScore;
  return lowScore + ((x - low) / (high - low)) * (highScore - lowScore);
}

function secuCode(row) {
  const code = row.code;
  if (row.market === "港股通" || /^\d{5}$/.test(code)) return `${code}.HK`;
  if (/^(6|688|689)/.test(code)) return `${code}.SH`;
  if (/^(8|4|920|430|831|832|833|834|835|836|837|838|839|870|871|872|873|874)/.test(code)) return `${code}.BJ`;
  return `${code}.SZ`;
}

function noticeStockList(row) {
  const code = row.code;
  if (row.market === "港股通" || /^\d{5}$/.test(code)) return `${code},116`;
  if (/^(6|688|689)/.test(code)) return `${code},1`;
  return `${code},0`;
}

function stripJsonp(text) {
  const trimmed = text.trim();
  const start = trimmed.indexOf("(");
  const end = trimmed.lastIndexOf(")");
  if (start >= 0 && end > start) return trimmed.slice(start + 1, end);
  return trimmed;
}

async function fetchJson(url, jsonp = false) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  if (!text) throw new Error("empty response");
  return JSON.parse(jsonp ? stripJsonp(text) : text);
}

async function fetchFinance(row, type, sty = "ALL", pageSize = 4) {
  const sc = secuCode(row);
  if (sc.endsWith(".HK")) return { data: [], error: "hk_f10_not_supported" };
	const url =
		"https://datacenter.eastmoney.com/securities/api/data/get" +
		`?type=${type}` +
		`&sty=${sty}` +
		"&st=REPORT_DATE&sr=-1" +
		(eastmoneyF10Token ? `&token=${encodeURIComponent(eastmoneyF10Token)}` : "") +
		`&filter=(SECUCODE%3D%22${encodeURIComponent(sc)}%22)` +
		`&p=1&ps=${pageSize}&source=F10`;
  try {
    const json = await fetchJson(url);
    if (json?.result?.data) return { data: json.result.data, error: "" };
    return { data: [], error: json.message || json.error || "no_finance_data" };
  } catch (err) {
    return { data: [], error: err.message || String(err) };
  }
}

async function fetchNotices(row) {
  const url =
    "https://np-anotice-stock.eastmoney.com/api/security/ann" +
    "?cb=jQuery" +
    `&stock_list=${encodeURIComponent(noticeStockList(row))}` +
    "&page_size=20&page_index=1" +
    "&ann_type=A" +
    "&client_source=web" +
    `&begin_time=${beginDate}` +
    `&end_time=${today}`;
  try {
    const json = await fetchJson(url, true);
    return { notices: json?.data?.list || [], error: "" };
  } catch (err) {
    return { notices: [], error: err.message || String(err) };
  }
}

function latest(data) {
  return Array.isArray(data) && data.length ? data[0] : null;
}

function sumLatestTitles(notices) {
  return notices.map((item) => item.title || item.title_ch || "").filter(Boolean);
}

function countKeyword(titles, regex) {
  return titles.reduce((count, title) => count + (regex.test(title) ? 1 : 0), 0);
}

function financeQuality(income, cashflow, balance, missing) {
  if (!income) {
    missing.push("finance_income");
    return { score: 45, risk: 6, metrics: {}, reasons: [], risks: ["缺利润表数据"] };
  }
  const revenue = n(income.TOTAL_OPERATE_INCOME);
  const revenueYoy = n(income.TOTAL_OPERATE_INCOME_YOY);
  const netProfit = n(income.PARENT_NETPROFIT ?? income.NETPROFIT);
  const netProfitYoy = n(income.PARENT_NETPROFIT_YOY ?? income.NETPROFIT_YOY);
  const rdExpense = n(income.RESEARCH_EXPENSE);
  const cashOperate = cashflow ? n(cashflow.NETCASH_OPERATE) : null;
  const totalAssets = balance ? n(balance.TOTAL_ASSETS) : null;
  const totalLiab = balance ? n(balance.TOTAL_LIABILITIES) : null;
  const equity = balance ? n(balance.TOTAL_EQUITY ?? balance.TOTAL_PARENT_EQUITY) : null;
  const receivables = balance ? n(balance.ACCOUNTS_RECE) : null;
  const goodwill = balance ? n(balance.GOODWILL) : null;

  const rdRatio = revenue && rdExpense != null ? (rdExpense / revenue) * 100 : null;
  const cfoNetProfit = netProfit && cashOperate != null ? cashOperate / Math.abs(netProfit) : null;
  const debtRatio = totalAssets && totalLiab != null ? (totalLiab / totalAssets) * 100 : null;
  const receivableRevenue = revenue && receivables != null ? (receivables / Math.max(revenue, 1)) * 100 : null;
  const goodwillEquity = equity && goodwill != null ? (goodwill / Math.max(equity, 1)) * 100 : null;

  let score = 50;
  score += scoreLinear(revenueYoy, -25, 35, -12, 16);
  score += scoreLinear(netProfitYoy, -50, 60, -16, 18);
  if (netProfit != null) score += netProfit > 0 ? 8 : -12;
  if (cashOperate != null) score += cashOperate > 0 ? 7 : -8;
  if (cfoNetProfit != null) score += cfoNetProfit > 0.8 ? 7 : cfoNetProfit > 0.2 ? 2 : -7;
  if (rdRatio != null) score += rdRatio >= 4 && rdRatio <= 18 ? 5 : rdRatio > 25 ? -4 : 0;
  if (debtRatio != null) score += debtRatio < 45 ? 6 : debtRatio < 65 ? 0 : -8;
  if (receivableRevenue != null) score += receivableRevenue < 60 ? 4 : receivableRevenue < 120 ? -2 : -8;
  if (goodwillEquity != null) score += goodwillEquity < 20 ? 4 : goodwillEquity < 50 ? -3 : -9;

  const reasons = [];
  const risks = [];
  if (revenueYoy != null && revenueYoy > 10) reasons.push(`收入同比${revenueYoy.toFixed(1)}%`);
  if (netProfitYoy != null && netProfitYoy > 20) reasons.push(`归母净利同比${netProfitYoy.toFixed(1)}%`);
  if (cashOperate != null && cashOperate > 0) reasons.push("经营现金流为正");
  if (rdRatio != null && rdRatio >= 4) reasons.push(`研发强度${rdRatio.toFixed(1)}%`);
  if (revenueYoy != null && revenueYoy < -10) risks.push(`收入同比${revenueYoy.toFixed(1)}%`);
  if (netProfitYoy != null && netProfitYoy < -20) risks.push(`归母净利同比${netProfitYoy.toFixed(1)}%`);
  if (netProfit != null && netProfit < 0) risks.push("净利润亏损");
  if (cashOperate != null && cashOperate < 0) risks.push("经营现金流为负");
  if (debtRatio != null && debtRatio > 65) risks.push(`资产负债率${debtRatio.toFixed(1)}%`);
  if (receivableRevenue != null && receivableRevenue > 120) risks.push("应收/收入偏高");
  if (goodwillEquity != null && goodwillEquity > 50) risks.push("商誉/权益偏高");

  if (!cashflow) missing.push("finance_cashflow");
  if (!balance) missing.push("finance_balance");

  return {
    score: clamp(score),
    risk: risks.length * 4,
    metrics: {
      report_date: income.REPORT_DATE_NAME || income.REPORT_DATE || "",
      revenue,
      revenue_yoy: revenueYoy,
      net_profit: netProfit,
      net_profit_yoy: netProfitYoy,
      rd_ratio: rdRatio,
      cash_operate: cashOperate,
      cfo_net_profit: cfoNetProfit,
      debt_ratio: debtRatio,
      receivable_revenue: receivableRevenue,
      goodwill_equity: goodwillEquity,
    },
    reasons,
    risks,
  };
}

function noticeReview(notices, noticeError, missing) {
  const titles = sumLatestTitles(notices);
  const positiveHits = countKeyword(
    titles,
    /机器人|人形|具身|AI|人工智能|智能|自动化|伺服|减速器|传感|视觉|光学|激光雷达|智驾|自动驾驶|边缘|芯片|数字孪生|订单|合作|中标|回购|股权激励/
  );
  const riskHits = countKeyword(titles, /减持|诉讼|仲裁|问询|监管|亏损|终止|退市|风险|质押|担保|处罚|立案|警示|债务|更正/);
  let score = 50 + Math.min(24, positiveHits * 6) - Math.min(24, riskHits * 8);
  if (!titles.length) {
    missing.push("recent_notices");
    score -= 4;
  }
  if (noticeError) missing.push("notice_error");
  const important = titles.slice(0, 5);
  return {
    score: clamp(score),
    risk: riskHits * 4,
    notice_count: titles.length,
    positive_hits: positiveHits,
    risk_hits: riskHits,
    latest_titles: important,
  };
}

function technicalReview(row) {
  const ret20 = n(row.ret20);
  const ret60 = n(row.ret60);
  const drawdown60 = n(row.drawdown60);
  const vol20 = n(row.vol20);
  const pct = n(row.pct_chg);
  let score = 50;
  if (ret20 != null) score += ret20 > 20 ? 18 : ret20 > 5 ? 8 : ret20 < -10 ? -10 : 0;
  if (ret60 != null) score += ret60 > 50 ? 14 : ret60 > 15 ? 8 : ret60 < -15 ? -10 : 0;
  if (drawdown60 != null) score += drawdown60 > -8 ? 8 : drawdown60 < -20 ? -8 : 0;
  if (vol20 != null) score += vol20 > 100 ? -10 : vol20 > 75 ? -4 : vol20 < 35 ? 4 : 0;
  if (pct != null && pct > 9) score -= 5;
  if (pct != null && pct < -7) score -= 7;
  const risks = [];
  if (vol20 != null && vol20 > 95) risks.push("波动率高");
  if (drawdown60 != null && drawdown60 < -20) risks.push("60日回撤深");
  if (ret20 != null && ret20 > 45) risks.push("短期涨幅过大");
  return { score: clamp(score), risks };
}

function valuationReview(row) {
  const pe = n(row.pe);
  const pb = n(row.pb);
  let score = n(row.valuation_score, 50);
  let risk = 0;
  const risks = [];
  if (pe != null && (pe < 0 || pe > 180)) {
    risk += 10;
    risks.push(pe < 0 ? "PE为负" : "PE极高");
  }
  if (pb != null && pb > 12) {
    risk += 8;
    risks.push("PB极高");
  }
  if (row.market === "港股通" && pe == null) {
    score -= 5;
    risks.push("港股PE缺失");
  }
  return { score: clamp(score), risk, risks };
}

function themeValidation(row) {
  let score = n(row.theme_purity_score, 70);
  const tier = row.review_tier || "";
  const chain = row.physical_ai_chain || "";
  if (tier.includes("T1")) score += 8;
  if (tier.includes("T2")) score += 2;
  if (tier.includes("T4")) score -= 18;
  if (/执行控制|感知|机器人本体|边缘AI\/自动驾驶|边缘AI\/芯片/.test(chain)) score += 6;
  if (/宽口径|通信|材料|电池|元件/.test(chain)) score -= 8;
  return clamp(score);
}

function buildVerdict(score, risk, row, missing) {
  const tier = row.review_tier || "";
  if (tier.includes("T4") || score < 58) return "剔除Top优先";
  if (score >= 80 && risk <= 24) return "深研优先A";
  if (score >= 72 && risk <= 34) return "深研优先B";
  if (score >= 64) return "观察验证";
  if (missing.length >= 3) return "数据不足观察";
  return "降权观察";
}

function entryStyle(row, verdict) {
  const price = n(row.price);
  const ret20 = n(row.ret20);
  const drawdown60 = n(row.drawdown60);
  if (!price || verdict.includes("剔除")) return "不设买点，先剔除Top优先";
  if (ret20 != null && ret20 > 30) return `高位强势，等回踩20日线附近或放量突破后再试，不追涨`;
  if (drawdown60 != null && drawdown60 < -15) return `左侧修复，等重新站上20日线并放量确认`;
  return `分批试仓，放量站稳上一交易日高点可小仓确认`;
}

async function reviewOne(row, index) {
  const missing = [];
  const [incomeRes, cashflowRes, balanceRes, noticeRes] = await Promise.all([
    fetchFinance(row, "RPT_F10_FINANCE_GINCOME", "ALL", 4),
    fetchFinance(row, "RPT_F10_FINANCE_GCASHFLOW", "ALL", 4),
    fetchFinance(row, "RPT_F10_FINANCE_GBALANCE", "ALL", 4),
    fetchNotices(row),
  ]);
  const finance = financeQuality(
    latest(incomeRes.data),
    latest(cashflowRes.data),
    latest(balanceRes.data),
    missing
  );
  if (incomeRes.error && !incomeRes.error.includes("not_supported")) missing.push(`income_error:${incomeRes.error}`);
  if (cashflowRes.error && !cashflowRes.error.includes("not_supported")) missing.push(`cashflow_error:${cashflowRes.error}`);
  if (balanceRes.error && !balanceRes.error.includes("not_supported")) missing.push(`balance_error:${balanceRes.error}`);
  if (incomeRes.error.includes("hk_f10_not_supported")) missing.push("hk_finance_not_supported");

  const notices = noticeReview(noticeRes.notices, noticeRes.error, missing);
  const technical = technicalReview(row);
  const valuation = valuationReview(row);
  const theme = themeValidation(row);
  const liquidity = n(row.liquidity_score, 50);
  const riskPenalty = clamp(
    n(row.risk_penalty, 0) +
      finance.risk +
      notices.risk +
      valuation.risk +
      (technical.risks.length * 4) +
      (missing.includes("hk_finance_not_supported") ? 5 : 0),
    0,
    80
  );
  const reviewedBase = n(row.reviewed_expected_value_score, n(row.expected_value_score, 50));
  const deepScore = clamp(
    reviewedBase * 0.2 +
      theme * 0.18 +
      finance.score * 0.18 +
      technical.score * 0.16 +
      notices.score * 0.12 +
      liquidity * 0.1 +
      valuation.score * 0.06 -
      riskPenalty * 0.15
  );
  const valueBet = clamp(
    theme * 0.2 +
      notices.score * 0.18 +
      valuation.score * 0.18 +
      finance.score * 0.17 +
      technical.score * 0.13 +
      liquidity * 0.08 +
      reviewedBase * 0.06 -
      riskPenalty * 0.18
  );
  const shortMid = clamp(
    technical.score * 0.25 +
      notices.score * 0.17 +
      theme * 0.16 +
      liquidity * 0.14 +
      finance.score * 0.12 +
      reviewedBase * 0.1 +
      valuation.score * 0.06 -
      riskPenalty * 0.16
  );
  const verdict = buildVerdict(deepScore, riskPenalty, row, missing);
  const positives = [
    ...(finance.reasons || []),
    notices.positive_hits ? `公告催化命中${notices.positive_hits}` : "",
    theme >= 90 ? "主题穿透强" : "",
    technical.score >= 70 ? "量价结构强" : "",
  ].filter(Boolean);
  const risks = [
    ...(finance.risks || []),
    ...(valuation.risks || []),
    ...(technical.risks || []),
    notices.risk_hits ? `公告风险命中${notices.risk_hits}` : "",
    ...(row.risks ? row.risks.split("|").filter(Boolean) : []),
  ].filter(Boolean);

  return {
    run_id: runId,
    data_time: dataTime,
    review_rank: n(row.review_rank, index + 1),
    code: row.code,
    name: row.name,
    market: row.market,
    industry: row.industry,
    physical_ai_chain: row.physical_ai_chain,
    first_pass_tier: row.review_tier,
    deep_verdict: verdict,
    deep_expected_value_score: Number(deepScore.toFixed(1)),
    deep_value_bet_score: Number(valueBet.toFixed(1)),
    deep_short_mid_score: Number(shortMid.toFixed(1)),
    reviewed_expected_value_score: n(row.reviewed_expected_value_score),
    theme_validation_score: Number(theme.toFixed(1)),
    finance_quality_score: Number(finance.score.toFixed(1)),
    notice_catalyst_score: Number(notices.score.toFixed(1)),
    technical_setup_score: Number(technical.score.toFixed(1)),
    valuation_deep_score: Number(valuation.score.toFixed(1)),
    liquidity_score: liquidity,
    deep_risk_penalty: Number(riskPenalty.toFixed(1)),
    price: n(row.price),
    pct_chg: n(row.pct_chg),
    amount: n(row.amount),
    pe: n(row.pe),
    pb: n(row.pb),
    ret20: n(row.ret20),
    ret60: n(row.ret60),
    drawdown60: n(row.drawdown60),
    vol20: n(row.vol20),
    report_date: finance.metrics.report_date || "",
    revenue_yoy: finance.metrics.revenue_yoy,
    net_profit_yoy: finance.metrics.net_profit_yoy,
    rd_ratio: finance.metrics.rd_ratio,
    cfo_net_profit: finance.metrics.cfo_net_profit,
    debt_ratio: finance.metrics.debt_ratio,
    receivable_revenue: finance.metrics.receivable_revenue,
    goodwill_equity: finance.metrics.goodwill_equity,
    notice_count_180d: notices.notice_count,
    notice_positive_hits: notices.positive_hits,
    notice_risk_hits: notices.risk_hits,
    key_positive: positives.slice(0, 5).join("|"),
    key_risk: risks.slice(0, 6).join("|"),
    latest_notices: notices.latest_titles.join("；"),
    entry_style: entryStyle(row, verdict),
    must_verify_next: [
      "物理AI相关收入/订单占比",
      "最新公告是否有机器人/感知/边缘AI实质订单",
      "估值与同业分位",
      "20日线/成交额是否支撑进场",
    ].join("|"),
    missing_fields: Array.from(new Set(missing)).join("|"),
    source: `${row.source}|eastmoney_f10|eastmoney_notice|tencent_kline_snapshot`,
  };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        results[i] = {
          run_id: runId,
          data_time: dataTime,
          review_rank: n(items[i].review_rank, i + 1),
          code: items[i].code,
          name: items[i].name,
          market: items[i].market,
          deep_verdict: "失败待重试",
          deep_expected_value_score: 0,
          error: err.message || String(err),
          missing_fields: "deep_review_error",
        };
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

function readAgentQc() {
  const files = fs.existsSync(outDir)
    ? fs.readdirSync(outDir).filter((f) => /^agent_qc_rank.*\.jsonl$/.test(f))
    : [];
  const map = new Map();
  for (const file of files) {
    const lines = fs.readFileSync(path.join(outDir, file), "utf8").split(/\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (item.code) map.set(item.code, item);
      } catch {}
    }
  }
  return map;
}

function applyAgentQc(rows) {
  const qc = readAgentQc();
  return rows.map((row) => {
    const item = qc.get(row.code);
    if (!item) return row;
    let adjusted = row.deep_expected_value_score;
    if (item.qc_depth_verdict === "保留核心") adjusted += item.qc_theme_purity === "高" ? 2 : 0;
    if (item.qc_depth_verdict === "降为观察") adjusted -= 4;
    if (item.qc_depth_verdict === "剔除Top优先") adjusted -= 8;
    const verdict =
      item.qc_depth_verdict === "剔除Top优先"
        ? "剔除Top优先"
        : item.qc_depth_verdict === "降为观察" && row.deep_verdict.includes("深研")
          ? "观察验证"
          : row.deep_verdict;
    return {
      ...row,
      agent_qc_theme_purity: item.qc_theme_purity || "",
      agent_qc_verdict: item.qc_depth_verdict || "",
      agent_qc_positive: item.key_positive || "",
      agent_qc_risk: item.key_risk || "",
      agent_qc_must_verify: item.must_verify_next || "",
      agent_qc_confidence: item.confidence || "",
      deep_expected_value_score_final: Number(clamp(adjusted).toFixed(1)),
      deep_verdict_final: verdict,
    };
  });
}

function summarize(rows) {
  const bucket = {};
  for (const row of rows) {
    const key = row.deep_verdict_final || row.deep_verdict;
    bucket[key] = (bucket[key] || 0) + 1;
  }
  const missingRows = rows.filter((row) => row.missing_fields);
  const top = rows
    .slice()
    .sort((a, b) => n(b.deep_expected_value_score_final, b.deep_expected_value_score) - n(a.deep_expected_value_score_final, a.deep_expected_value_score))
    .slice(0, 30);
  return {
    run_id: runId,
    data_time: dataTime,
    input,
    out_dir: outDir,
    universe_size: rows.length,
    reviewed: rows.length,
    verdict_counts: bucket,
    missing_count: missingRows.length,
    formula_version: "physical_ai_deep_review_v1",
    formula:
      "deep_score = 0.20*first_pass_review + 0.18*theme_validation + 0.18*finance_quality + 0.16*technical + 0.12*notice_catalyst + 0.10*liquidity + 0.06*valuation - 0.15*risk",
    top30: top.map((row, i) => ({
      rank: i + 1,
      code: row.code,
      name: row.name,
      market: row.market,
      chain: row.physical_ai_chain,
      verdict: row.deep_verdict_final || row.deep_verdict,
      score: n(row.deep_expected_value_score_final, row.deep_expected_value_score),
      key_positive: row.key_positive,
      key_risk: row.key_risk,
    })),
  };
}

function writeReport(rows, summary) {
  const sorted = rows
    .slice()
    .sort((a, b) => n(b.deep_expected_value_score_final, b.deep_expected_value_score) - n(a.deep_expected_value_score_final, a.deep_expected_value_score));
  const topRows = sorted.slice(0, 30);
  const downgraded = rows.filter((r) => (r.deep_verdict_final || r.deep_verdict).includes("剔除") || (r.deep_verdict_final || r.deep_verdict).includes("降权")).slice(0, 30);
  const md = (value) => String(value || "-").replace(/\|/g, "；").replace(/\n/g, " ");
  const table = topRows.map((row, i) =>
    `| ${i + 1} | ${row.code} | ${row.name} | ${row.market} | ${row.physical_ai_chain} | ${row.deep_verdict_final || row.deep_verdict} | ${n(row.deep_expected_value_score_final, row.deep_expected_value_score)} | ${row.deep_value_bet_score} | ${row.deep_short_mid_score} | ${md(row.key_positive)} | ${md(row.key_risk)} |`
  );
  const downgradedTable = downgraded.map((row) =>
    `| ${row.review_rank} | ${row.code} | ${row.name} | ${row.first_pass_tier} | ${row.deep_verdict_final || row.deep_verdict} | ${n(row.deep_expected_value_score_final, row.deep_expected_value_score)} | ${md(row.key_risk || row.missing_fields)} |`
  );
  const text = [
    "# Alpha 物理 AI Top100 深度复核",
    "",
    `生成时间：${today} Asia/Shanghai`,
    "",
    "## 短结论",
    "",
    `Top100 已完成第二步深度复核：${summary.reviewed}/${summary.universe_size} 只完成结构化记录。`,
    "",
    `分布：${Object.entries(summary.verdict_counts).map(([k, v]) => `${k} ${v}`).join("，")}。`,
    "",
    "这一步引入了财务质量、公告催化/风险、量价结构、估值、流动性和主题穿透复核；它仍不是最终交易指令，下一步要对深研优先 A/B 做单票交易计划。",
    "",
    "## 评分公式",
    "",
    "```text",
    summary.formula,
    "```",
    "",
    "## 深度复核 Top30",
    "",
    "| 排名 | 代码 | 名称 | 市场 | 链条 | 结论 | 深复核分 | 值搏率 | 短中期分 | 正面证据 | 主要风险 |",
    "|---:|---|---|---|---|---|---:|---:|---:|---|---|",
    ...table,
    "",
    "## 典型降权/剔除",
    "",
    "| 原排名 | 代码 | 名称 | 首轮分层 | 深复核结论 | 深复核分 | 主要问题 |",
    "|---:|---|---|---|---|---:|---|",
    ...downgradedTable,
    "",
    "## 产物",
    "",
    `- ${path.join(outDir, "deep_review_top100.jsonl")}`,
    `- ${path.join(outDir, "deep_review_top100.csv")}`,
    `- ${path.join(outDir, "deep_review_top30.csv")}`,
    `- ${path.join(outDir, "deep_review_downgraded.csv")}`,
    `- ${path.join(outDir, "deep_review_summary.json")}`,
    "",
    "## 数据边界",
    "",
    "- A 股财务来自东方财富 F10 利润表、现金流量表、资产负债表接口。",
    "- 公告来自东方财富公告接口，窗口为 2025-12-01 至 2026-06-04。",
    "- 港股通 F10 财务在当前接口下多为空，已写入缺失字段；港股深研需要补港交所公告/年报。",
    "- 北交所部分股票 K 线或财务字段可能不完整，已在明细 missing_fields 中保留。",
    "",
    "## 下一步",
    "",
    "对深研优先 A/B 中的前 20-30 只，逐只补公告原文、收入敞口、订单客户、同业估值、资金流和买卖触发条件。",
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "DEEP_REVIEW_REPORT.md"), text);
}

async function main() {
  const rows = parseCsv(fs.readFileSync(input, "utf8")).slice(0, 100);
  const reviewed = await mapLimit(rows, 8, reviewOne);
  const merged = applyAgentQc(reviewed);
  merged.sort((a, b) => n(b.deep_expected_value_score_final, b.deep_expected_value_score) - n(a.deep_expected_value_score_final, a.deep_expected_value_score));
  merged.forEach((row, i) => {
    row.deep_rank = i + 1;
  });

  const jsonl = merged.map((row) => JSON.stringify(row)).join("\n") + "\n";
  fs.writeFileSync(path.join(outDir, "deep_review_top100.jsonl"), jsonl);

  const cols = [
    "deep_rank",
    "review_rank",
    "code",
    "name",
    "market",
    "industry",
    "physical_ai_chain",
    "first_pass_tier",
    "deep_verdict_final",
    "deep_verdict",
    "deep_expected_value_score_final",
    "deep_expected_value_score",
    "deep_value_bet_score",
    "deep_short_mid_score",
    "theme_validation_score",
    "finance_quality_score",
    "notice_catalyst_score",
    "technical_setup_score",
    "valuation_deep_score",
    "liquidity_score",
    "deep_risk_penalty",
    "price",
    "pct_chg",
    "amount",
    "pe",
    "pb",
    "ret20",
    "ret60",
    "drawdown60",
    "vol20",
    "report_date",
    "revenue_yoy",
    "net_profit_yoy",
    "rd_ratio",
    "cfo_net_profit",
    "debt_ratio",
    "receivable_revenue",
    "goodwill_equity",
    "notice_count_180d",
    "notice_positive_hits",
    "notice_risk_hits",
    "key_positive",
    "key_risk",
    "latest_notices",
    "entry_style",
    "must_verify_next",
    "agent_qc_theme_purity",
    "agent_qc_verdict",
    "agent_qc_risk",
    "agent_qc_confidence",
    "missing_fields",
    "source",
  ];
  writeCsv("deep_review_top100.csv", merged, cols);
  writeCsv("deep_review_top30.csv", merged.slice(0, 30), cols);
  writeCsv(
    "deep_review_downgraded.csv",
    merged.filter((row) => (row.deep_verdict_final || row.deep_verdict || "").match(/剔除|降权|数据不足/)),
    cols
  );
  const summary = summarize(merged);
  fs.writeFileSync(path.join(outDir, "deep_review_summary.json"), JSON.stringify(summary, null, 2));
  writeReport(merged, summary);
  console.log(JSON.stringify({
    out_dir: outDir,
    reviewed: merged.length,
    verdict_counts: summary.verdict_counts,
    top10: summary.top30.slice(0, 10),
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
