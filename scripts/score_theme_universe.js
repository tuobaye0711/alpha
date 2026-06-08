#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { defaultOutputRoot } = require("./lib/paths");

const runId = process.env.ALPHA_RUN_ID || "theme-score-20260604-1715";
const outputRoot = defaultOutputRoot();
const input =
  process.argv[2] ||
  path.join(outputRoot, "theme-universe-20260604-1700", "alpha_core_candidates.csv");
const outDir =
  process.argv[3] ||
  path.join(outputRoot, runId);

const headers = {
  "user-agent": "Mozilla/5.0",
  referer: "https://quote.eastmoney.com/",
};

const themePrior = {
  "AIDC电力液冷": 94,
  "具身智能机器人": 90,
  "创新药出海": 92,
  "商业航天卫星互联网": 86,
  固态电池: 84,
  "先进封装HBM存储国产化": 89,
  核聚变核能: 80,
  "低空经济eVTOL": 78,
  "稳定币RWA数字金融": 75,
  "AI Agent垂直应用": 76,
  "物理AI": 91,
};

const preferredThemes = new Set([
  "AIDC电力液冷",
  "具身智能机器人",
  "创新药出海",
  "商业航天卫星互联网",
  "固态电池",
  "先进封装HBM存储国产化",
  "物理AI",
]);

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

function num(value) {
  if (value == null || value === "" || value === "-") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(x, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, x));
}

function scoreRange(x, bad, good, excellent) {
  if (x == null) return 45;
  if (x <= bad) return 15 + (x / bad) * 20;
  if (x <= good) return 35 + ((x - bad) / (good - bad)) * 35;
  if (x <= excellent) return 70 + ((x - good) / (excellent - good)) * 25;
  return 95;
}

function marketPrefix(row) {
  const code = row.code;
  if (row.market === "港股通" || /^\d{5}$/.test(code)) return `hk${code}`;
  if (/^(6|688|689)/.test(code)) return `sh${code}`;
  if (/^(8|4|920|430|831|832|833|834|835|836|837|838|839|870|871|872|873|874)/.test(code)) {
    return `bj${code}`;
  }
  return `sz${code}`;
}

async function fetchKline(symbol) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,180,qfq`;
  const res = await fetch(url, { headers });
  const text = await res.text();
  if (!text || !text.startsWith("{")) {
    throw new Error(`non-json kline response: ${text.slice(0, 60)}`);
  }
  const json = JSON.parse(text);
  const item = json.data?.[symbol];
  if (!item) throw new Error("missing symbol data");
  const rows = item.qfqday || item.day || item.hfqday || [];
  return rows.map((r) => ({
    date: r[0],
    open: Number(r[1]),
    close: Number(r[2]),
    high: Number(r[3]),
    low: Number(r[4]),
    volume: Number(r[5]),
  })).filter((r) => Number.isFinite(r.close));
}

function returns(kline) {
  if (!kline.length) return {};
  const last = kline[kline.length - 1].close;
  const retN = (n) => {
    if (kline.length <= n) return null;
    const base = kline[kline.length - 1 - n].close;
    return base > 0 ? ((last / base) - 1) * 100 : null;
  };
  const slice20 = kline.slice(-20);
  const slice60 = kline.slice(-60);
  const max60 = Math.max(...slice60.map((r) => r.high));
  const min60 = Math.min(...slice60.map((r) => r.low));
  const ma20 = slice20.reduce((s, r) => s + r.close, 0) / Math.max(1, slice20.length);
  const daily = [];
  for (let i = Math.max(1, kline.length - 21); i < kline.length; i += 1) {
    const prev = kline[i - 1].close;
    if (prev > 0) daily.push((kline[i].close / prev) - 1);
  }
  const avg = daily.reduce((s, x) => s + x, 0) / Math.max(1, daily.length);
  const variance = daily.reduce((s, x) => s + (x - avg) ** 2, 0) / Math.max(1, daily.length);
  const vol20 = Math.sqrt(variance) * Math.sqrt(252) * 100;
  return {
    last_close: last,
    ret5: retN(5),
    ret20: retN(20),
    ret60: retN(60),
    ret120: retN(120),
    ma20,
    dist_ma20: ma20 > 0 ? ((last / ma20) - 1) * 100 : null,
    drawdown60: max60 > 0 ? ((last / max60) - 1) * 100 : null,
    range60: min60 > 0 ? ((max60 / min60) - 1) * 100 : null,
    vol20,
    days: kline.length,
  };
}

function liquidityScore(amount, marketCap) {
  const amountScore = scoreRange(amount, 10_000_000, 100_000_000, 800_000_000);
  const capScore = marketCap == null
    ? 50
    : marketCap < 3_000_000_000
      ? 35
      : marketCap < 15_000_000_000
        ? 78
        : marketCap < 100_000_000_000
          ? 88
          : marketCap < 500_000_000_000
            ? 72
            : 55;
  return clamp(amountScore * 0.75 + capScore * 0.25);
}

function valuationScore(row) {
  const pe = num(row.pe);
  const pb = num(row.pb);
  const theme = row.theme;
  let peScore;
  if (pe == null || pe === 0) peScore = theme === "创新药出海" ? 58 : 48;
  else if (pe < 0) peScore = theme === "创新药出海" ? 42 : 25;
  else if (pe <= 15) peScore = 80;
  else if (pe <= 35) peScore = 92;
  else if (pe <= 60) peScore = 76;
  else if (pe <= 100) peScore = 58;
  else if (pe <= 180) peScore = 38;
  else peScore = 22;

  let pbScore;
  if (pb == null || pb === 0) pbScore = 50;
  else if (pb <= 1.5) pbScore = 90;
  else if (pb <= 4) pbScore = 80;
  else if (pb <= 8) pbScore = 58;
  else if (pb <= 15) pbScore = 36;
  else pbScore = 20;

  const innovationBoost = theme === "创新药出海" ? 6 : 0;
  return clamp(peScore * 0.65 + pbScore * 0.35 + innovationBoost);
}

function themePurityScore(row) {
  const concepts = row.concepts ? row.concepts.split("|").filter(Boolean).length : 0;
  let score = row.relevance.includes("核心") ? 84 : 62;
  if (row.relevance.includes("接口核心")) score = 72;
  if (row.source.includes("manual_core_supplement")) score = Math.max(score, 86);
  score += Math.min(12, concepts * 3);
  score += preferredThemes.has(row.theme) ? 4 : 0;
  if (row.market === "科创板" && ["创新药出海", "先进封装HBM存储国产化", "商业航天卫星互联网"].includes(row.theme)) score += 3;
  if (row.market === "北交所/新三板系") score -= 5;
  return clamp(score);
}

function momentumScore(metrics, oneDayPct) {
  if (!metrics.days) return clamp(45 + (oneDayPct || 0));
  const r20 = metrics.ret20 ?? 0;
  const r60 = metrics.ret60 ?? 0;
  const dist = metrics.dist_ma20 ?? 0;
  const dd = metrics.drawdown60 ?? -10;
  const vol = metrics.vol20 ?? 45;
  let score = 50;
  score += clamp(r20, -20, 35) * 0.75;
  score += clamp(r60, -30, 80) * 0.32;
  score += dist > 0 ? Math.min(12, dist * 0.7) : Math.max(-16, dist * 0.8);
  score += dd > -8 ? 8 : dd > -18 ? 2 : -8;
  if (vol > 95) score -= 10;
  if (oneDayPct != null && oneDayPct > 12) score -= 8;
  if (oneDayPct != null && oneDayPct < -8) score -= 8;
  return clamp(score);
}

function riskPenalty(row, metrics, liquidity) {
  let penalty = 0;
  const name = row.name || "";
  const pe = num(row.pe);
  const pb = num(row.pb);
  const one = num(row.pct_chg);
  if (/ST|退/.test(name)) penalty += 60;
  if (liquidity < 40) penalty += 12;
  if (metrics.days && metrics.drawdown60 < -35) penalty += 10;
  if (metrics.days && metrics.vol20 > 110) penalty += 10;
  if (one != null && one > 15) penalty += 8;
  if (one != null && one < -10) penalty += 8;
  if (pe != null && pe < 0 && row.theme !== "创新药出海") penalty += 8;
  if (pe != null && pe > 180) penalty += 12;
  if (pb != null && pb > 15) penalty += 10;
  if (row.market === "北交所/新三板系") penalty += 5;
  return clamp(penalty, 0, 100);
}

function verdict(alpha, valueBet, shortTerm, risk) {
  if (risk >= 45) return "回避/高风险";
  if (alpha >= 78 && valueBet >= 78 && shortTerm >= 68) return "进攻候选";
  if (valueBet >= 72 && shortTerm >= 60) return "试仓候选";
  if (alpha >= 68 || valueBet >= 68) return "观察候选";
  return "暂不优先";
}

async function mapLimit(items, limit, worker) {
  const ret = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next;
      next += 1;
      ret[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: limit }, run));
  return ret;
}

function explain(row, metrics, scores) {
  const reasons = [];
  if (scores.theme_purity_score >= 88) reasons.push("主题纯度高");
  if (scores.liquidity_score >= 75) reasons.push("成交/市值承载较好");
  if (scores.momentum_score >= 70) reasons.push("20/60日趋势占优");
  if (scores.valuation_score >= 75) reasons.push("估值相对可接受");
  if (themePrior[row.theme] >= 89) reasons.push("所属主题产业弹性强");
  if (!reasons.length) reasons.push("综合评分进入可观察范围");
  const risks = [];
  if (scores.risk_penalty >= 25) risks.push("风险扣分偏高");
  if (num(row.pe) != null && num(row.pe) > 100) risks.push("估值偏高");
  if (metrics.drawdown60 != null && metrics.drawdown60 < -25) risks.push("60日回撤较深");
  if (metrics.vol20 != null && metrics.vol20 > 90) risks.push("波动率高");
  if (scores.liquidity_score < 45) risks.push("流动性一般");
  return { reasons, risks };
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const rows = parseCsv(fs.readFileSync(input, "utf8"));
  const startedAt = new Date().toISOString();

  const results = await mapLimit(rows, 12, async (row, i) => {
    const symbol = marketPrefix(row);
    let kline = [];
    let klineError = "";
    try {
      kline = await fetchKline(symbol);
    } catch (err) {
      klineError = err.message || String(err);
    }
    const metrics = returns(kline);
    const amount = num(row.amount);
    const marketCap = num(row.total_mv);
    const oneDayPct = num(row.pct_chg);
    const liquidity = liquidityScore(amount, marketCap);
    const valuation = valuationScore(row);
    const purity = themePurityScore(row);
    const theme = themePrior[row.theme] ?? 70;
    const momentum = momentumScore(metrics, oneDayPct);
    const risk = riskPenalty(row, metrics, liquidity);
    const catalyst = clamp(theme * 0.72 + purity * 0.28);

    const alpha = clamp(
      0.20 * liquidity +
      0.22 * momentum +
      0.22 * catalyst +
      0.16 * purity +
      0.15 * valuation -
      0.15 * risk
    );
    const valueBet = clamp(
      0.28 * catalyst +
      0.22 * purity +
      0.20 * valuation +
      0.16 * momentum +
      0.10 * liquidity -
      0.18 * risk
    );
    const shortTerm = clamp(
      0.34 * momentum +
      0.24 * liquidity +
      0.18 * catalyst +
      0.12 * purity +
      0.08 * valuation -
      0.22 * risk
    );
    const expectedValue = clamp(0.45 * valueBet + 0.35 * shortTerm + 0.20 * alpha);
    const scores = {
      liquidity_score: +liquidity.toFixed(1),
      momentum_score: +momentum.toFixed(1),
      catalyst_score: +catalyst.toFixed(1),
      theme_purity_score: +purity.toFixed(1),
      valuation_score: +valuation.toFixed(1),
      risk_penalty: +risk.toFixed(1),
      alpha_score: +alpha.toFixed(1),
      value_bet_score: +valueBet.toFixed(1),
      short_term_score: +shortTerm.toFixed(1),
      expected_value_score: +expectedValue.toFixed(1),
    };
    const details = explain(row, metrics, scores);
    return {
      run_id: runId,
      status: "scored",
      row_index: i,
      data_time: startedAt,
      theme: row.theme,
      code: row.code,
      name: row.name,
      market: row.market,
      industry: row.industry,
      relevance: row.relevance,
      source: row.source,
      price: num(row.price),
      pct_chg: oneDayPct,
      amount,
      pe: num(row.pe),
      pb: num(row.pb),
      total_mv: marketCap,
      concepts: row.concepts,
      symbol,
      kline_days: metrics.days || 0,
      kline_error: klineError,
      ret5: metrics.ret5 == null ? null : +metrics.ret5.toFixed(2),
      ret20: metrics.ret20 == null ? null : +metrics.ret20.toFixed(2),
      ret60: metrics.ret60 == null ? null : +metrics.ret60.toFixed(2),
      ret120: metrics.ret120 == null ? null : +metrics.ret120.toFixed(2),
      dist_ma20: metrics.dist_ma20 == null ? null : +metrics.dist_ma20.toFixed(2),
      drawdown60: metrics.drawdown60 == null ? null : +metrics.drawdown60.toFixed(2),
      vol20: metrics.vol20 == null ? null : +metrics.vol20.toFixed(2),
      ...scores,
      verdict: verdict(alpha, valueBet, shortTerm, risk),
      reasons: details.reasons,
      risks: details.risks,
      missing_fields: [
        !row.price ? "price" : "",
        !row.amount ? "amount" : "",
        !row.pe ? "pe" : "",
        !row.pb ? "pb" : "",
        !kline.length ? "kline" : "",
      ].filter(Boolean),
    };
  });

  const sorted = [...results].sort((a, b) =>
    b.expected_value_score - a.expected_value_score ||
    b.value_bet_score - a.value_bet_score ||
    b.alpha_score - a.alpha_score
  );

  fs.writeFileSync(
    path.join(outDir, "per_stock_scores.jsonl"),
    results.map((r) => JSON.stringify(r)).join("\n") + "\n"
  );

  const csvCols = [
    "theme", "code", "name", "market", "industry", "verdict",
    "expected_value_score", "alpha_score", "value_bet_score", "short_term_score",
    "liquidity_score", "momentum_score", "catalyst_score", "theme_purity_score",
    "valuation_score", "risk_penalty", "price", "pct_chg", "amount", "pe", "pb",
    "ret5", "ret20", "ret60", "drawdown60", "vol20", "reasons", "risks", "missing_fields", "source"
  ];
  writeCsv("scored_candidates.csv", sorted.map((r, i) => ({ rank: i + 1, ...r, reasons: r.reasons.join("|"), risks: r.risks.join("|"), missing_fields: r.missing_fields.join("|") })), ["rank", ...csvCols]);

  const topByTheme = [];
  for (const theme of [...new Set(results.map((r) => r.theme))]) {
    const arr = sorted.filter((r) => r.theme === theme).slice(0, 30);
    arr.forEach((r, i) => topByTheme.push({ theme_rank: i + 1, ...r, reasons: r.reasons.join("|"), risks: r.risks.join("|"), missing_fields: r.missing_fields.join("|") }));
  }
  writeCsv("top_by_theme.csv", topByTheme, ["theme_rank", ...csvCols]);

  const failures = results.filter((r) => r.missing_fields.includes("kline"));
  writeCsv("failed_or_missing.csv", failures.map((r) => ({ ...r, reasons: r.reasons.join("|"), risks: r.risks.join("|"), missing_fields: r.missing_fields.join("|") })), csvCols);

  const summary = {
    run_id: runId,
    input,
    out_dir: outDir,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    universe_size: rows.length,
    scored: results.length,
    failed_or_missing_kline: failures.length,
    formula_version: "alpha_theme_score_v1",
    formula: {
      alpha_score: "0.20*liquidity + 0.22*momentum + 0.22*catalyst + 0.16*theme_purity + 0.15*valuation - 0.15*risk",
      value_bet: "0.28*catalyst + 0.22*theme_purity + 0.20*valuation + 0.16*momentum + 0.10*liquidity - 0.18*risk",
      short_term_score: "0.34*momentum + 0.24*liquidity + 0.18*catalyst + 0.12*theme_purity + 0.08*valuation - 0.22*risk",
    },
    by_theme: Object.fromEntries([...new Set(results.map((r) => r.theme))].map((theme) => {
      const arr = results.filter((r) => r.theme === theme);
      return [theme, {
        count: arr.length,
        avg_expected_value: +(arr.reduce((s, r) => s + r.expected_value_score, 0) / arr.length).toFixed(1),
        top: sorted.filter((r) => r.theme === theme).slice(0, 5).map((r) => `${r.code} ${r.name} ${r.expected_value_score}`),
      }];
    })),
    top20: sorted.slice(0, 20).map((r) => ({
      theme: r.theme,
      code: r.code,
      name: r.name,
      market: r.market,
      expected_value_score: r.expected_value_score,
      alpha_score: r.alpha_score,
      value_bet_score: r.value_bet_score,
      short_term_score: r.short_term_score,
      verdict: r.verdict,
    })),
  };
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
