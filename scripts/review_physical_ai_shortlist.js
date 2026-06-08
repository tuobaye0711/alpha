#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { defaultOutputRoot } = require("./lib/paths");

const scoreDir = process.argv[2] || path.join(defaultOutputRoot(), "physical-ai-score-20260604-1745");
const scoredCsv = path.join(scoreDir, "scored_candidates.csv");

function parseLine(line) {
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
  const cols = parseLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = parseLine(line);
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
    path.join(scoreDir, file),
    [cols.join(","), ...rows.map((row) => cols.map((c) => csvEscape(row[c])).join(","))].join("\n")
  );
}

function n(value) {
  const x = Number(value);
  return Number.isFinite(x) ? x : 0;
}

const strong = {
  "002747": ["机器人本体/运动控制", "工业机器人与运动控制核心"],
  "300124": ["执行控制", "工控/伺服/运动控制龙头"],
  "002472": ["执行控制", "精密传动/机器人关节链"],
  "688017": ["执行控制", "谐波减速器核心"],
  "002896": ["执行控制", "减速器/精密传动"],
  "003021": ["执行控制", "微型传动/执行器"],
  "603728": ["执行控制", "空心杯/电机链"],
  "002979": ["执行控制", "运动控制/驱动"],
  "688320": ["执行控制", "伺服/运动控制"],
  "688160": ["执行控制", "运动控制"],
  "300580": ["执行控制", "丝杠/精密传动链"],
  "603667": ["执行控制", "轴承/丝杠链"],
  "603009": ["执行控制", "丝杠链"],
  "430418": ["执行控制", "北交所微特电机/执行链"],
  "873593": ["执行控制", "北交所传感/执行链"],
  "002050": ["执行控制", "机器人热管理/执行器外溢"],
  "601689": ["执行控制", "机器人执行器/线控制动外溢"],
  "000887": ["执行控制", "机器人/汽车密封与底盘执行链"],
  "002823": ["执行控制", "电机/精密零部件，短线强但需订单验证"],
  "603203": ["智能制造", "自动化装备/焊接控制"],
  "002957": ["智能制造", "自动化设备"],
  "688308": ["智能制造", "高端制造刀具，偏智能制造弹性"],
  "688322": ["感知", "3D视觉/空间感知核心"],
  "02382": ["感知", "港股通光学/视觉核心"],
  "02018": ["感知", "港股通声学/触觉/精密硬件"],
  "01478": ["感知", "港股通摄像头模组"],
  "01415": ["感知", "港股通光学模组"],
  "002415": ["感知", "机器视觉/安防AI"],
  "002236": ["感知", "机器视觉/安防AI"],
  "688400": ["感知", "机器视觉"],
  "300007": ["感知", "传感器"],
  "301413": ["感知", "压力传感器"],
  "300667": ["感知", "MEMS/传感器"],
  "300114": ["感知", "传感器"],
  "832491": ["感知", "北交所超声/传感器"],
  "300978": ["感知", "3D视觉/空间感知"],
  "09660": ["边缘AI/自动驾驶", "港股通地平线机器人，车端AI芯片/平台"],
  "09880": ["机器人本体/平台", "港股通人形机器人整机"],
  "06600": ["机器人本体/平台", "港股通机器人本体"],
  "02252": ["机器人本体/平台", "港股通手术机器人"],
  "01810": ["边缘AI/机器人生态", "港股通端侧AI+汽车+机器人生态"],
  "09868": ["自动驾驶/自主系统", "港股通智能汽车/自动驾驶"],
  "09863": ["自动驾驶/自主系统", "港股通智能汽车"],
  "02015": ["自动驾驶/自主系统", "港股通智能汽车"],
  "01211": ["自动驾驶/自主系统", "港股通智能汽车+机器人制造"],
  "002594": ["自动驾驶/自主系统", "智能汽车+机器人制造"],
  "002920": ["边缘AI/自动驾驶", "智能座舱/驾驶域控"],
  "002405": ["边缘AI/自动驾驶", "智能汽车软件/域控"],
  "300496": ["边缘AI/自动驾驶", "智能汽车软件/操作系统"],
  "688326": ["边缘AI/自动驾驶", "智能驾驶/域控"],
  "688787": ["边缘AI/自动驾驶", "智能驾驶/域控"],
  "300458": ["边缘AI/自动驾驶", "车端视觉AI"],
  "688256": ["边缘AI/芯片", "AI芯片/边缘推理"],
  "688041": ["边缘AI/芯片", "AI算力芯片"],
  "300223": ["边缘AI/芯片", "端侧AI SoC"],
  "603893": ["边缘AI/芯片", "车规/IoT SoC"],
  "688521": ["边缘AI/芯片", "嵌入式CPU/IP"],
  "00020": ["边缘AI/世界模型", "港股通AI视觉平台"],
  "09678": ["边缘AI/语音交互", "港股通语音AI"],
  "03896": ["边缘AI/云仿真", "港股通AI云"],
  "03888": ["边缘AI/应用生态", "港股通AI软件生态"],
  "300212": ["仿真/空间智能", "数字孪生/城市空间"],
  "300075": ["仿真/空间智能", "数字孪生/数据要素"],
  "002151": ["定位导航", "北斗导航"],
  "300101": ["定位导航", "北斗芯片"],
  "688568": ["定位导航", "空天信息/空间数据"],
};

const downgrade = {
  "002245": "电池/锂电属性更强，物理AI直接纯度不足",
  "300975": "电子元器件分销属性更强，需订单穿透验证",
  "601609": "铜加工/材料属性更强，物理AI直接纯度不足",
  "600487": "光通信/线缆属性更强，物理AI不是主逻辑",
  "600596": "化工材料属性更强，物理AI不是主逻辑",
  "603890": "消费电子结构件属性更强，需穿透到机器人/空间计算订单",
  "300221": "材料属性较强，物理AI直接纯度不足",
  "000700": "汽车零部件属性强，物理AI需自动驾驶/机器人订单验证",
  "605111": "功率半导体通用属性，物理AI纯度不如专用边缘AI/机器人链",
  "688396": "功率半导体通用属性，物理AI纯度不如专用边缘AI/机器人链",
  "300184": "电子分销属性，需穿透到边缘AI/机器人客户",
  "301099": "电子分销属性，需穿透到车端/机器人客户",
  "002138": "被动元件属性，物理AI不是主逻辑",
  "002463": "PCB/AI服务器属性更强，物理AI直接纯度不足",
  "300476": "PCB/AI服务器属性更强，物理AI直接纯度不足",
  "300033": "金融AI/软件属性更强，不属于物理世界感知-决策-执行闭环核心",
  "300229": "知识检索/文本AI属性更强，物理AI直接纯度不足",
  "688111": "AI办公软件属性更强，物理AI关联较弱",
  "002230": "AI教育/办公软件属性更强，物理AI关联较弱",
};

function inferChain(row) {
  const industry = `${row.industry || ""} ${row.name || ""}`;
  if (/机器人|自动化|伺服|减速器|电机|运动控制|通用设备|工业母机/.test(industry)) return "机器人/执行控制";
  if (/传感|视觉|光学|激光雷达|毫米波|摄像|声学/.test(industry)) return "感知";
  if (/芯片|半导体|计算|软件|云|AI/.test(industry)) return "边缘AI/仿真";
  if (/汽车|无人驾驶|车联网|低空|无人机|导航|北斗/.test(industry)) return "自主系统";
  return "宽口径相关";
}

const rows = parseCsv(fs.readFileSync(scoredCsv, "utf8"));
const reviewed = rows.map((row) => {
  const code = row.code;
  const strongHit = strong[code];
  const downgradeReason = downgrade[code];
  let adjustment = 0;
  let reviewTier = "T3 观察";
  let purity = "宽口径相关";
  let reviewReason = "来自物理AI宽口径概念池，仍需订单/公告穿透";

  if (strongHit) {
    adjustment += 5;
    reviewTier = "T1 核心";
    [purity, reviewReason] = strongHit;
  }
  if (downgradeReason) {
    adjustment -= 9;
    reviewTier = strongHit ? "T2 需穿透验证" : "T4 降权";
    purity = strongHit ? purity : inferChain(row);
    reviewReason = downgradeReason;
  }
  if (!strongHit && !downgradeReason && n(row.theme_purity_score) >= 90) {
    adjustment += 2;
    reviewTier = "T2 需穿透验证";
    purity = inferChain(row);
    reviewReason = "主题分较高，但未进入手工核心清单";
  }
  if (!strongHit && !downgradeReason && n(row.theme_purity_score) < 78) {
    adjustment -= 4;
    reviewTier = "T4 降权";
    purity = inferChain(row);
    reviewReason = "机器主题分偏低，只保留宽口径观察";
  }

  const reviewedScore = Math.max(0, Math.min(100, n(row.expected_value_score) + adjustment));
  return {
    ...row,
    physical_ai_chain: purity,
    review_tier: reviewTier,
    purity_adjustment: adjustment.toFixed(1),
    reviewed_expected_value_score: reviewedScore.toFixed(1),
    review_reason: reviewReason,
  };
}).sort((a, b) => n(b.reviewed_expected_value_score) - n(a.reviewed_expected_value_score));

reviewed.forEach((row, i) => {
  row.review_rank = String(i + 1);
});

const cols = [
  "review_rank",
  "theme",
  "code",
  "name",
  "market",
  "industry",
  "physical_ai_chain",
  "review_tier",
  "reviewed_expected_value_score",
  "expected_value_score",
  "alpha_score",
  "value_bet_score",
  "short_term_score",
  "purity_adjustment",
  "theme_purity_score",
  "liquidity_score",
  "momentum_score",
  "catalyst_score",
  "valuation_score",
  "risk_penalty",
  "price",
  "pct_chg",
  "amount",
  "pe",
  "pb",
  "ret5",
  "ret20",
  "ret60",
  "drawdown60",
  "vol20",
  "review_reason",
  "reasons",
  "risks",
  "missing_fields",
  "source",
];

writeCsv("physical_ai_reviewed_candidates.csv", reviewed, cols);
writeCsv("physical_ai_reviewed_top100.csv", reviewed.slice(0, 100), cols);
writeCsv(
  "physical_ai_downgraded_after_review.csv",
  reviewed.filter((row) => n(row.purity_adjustment) < 0).slice(0, 200),
  cols
);

const tiers = reviewed.reduce((acc, row) => {
  acc[row.review_tier] = (acc[row.review_tier] || 0) + 1;
  return acc;
}, {});

const chains = reviewed.reduce((acc, row) => {
  acc[row.physical_ai_chain] = (acc[row.physical_ai_chain] || 0) + 1;
  return acc;
}, {});

fs.writeFileSync(
  path.join(scoreDir, "physical_ai_review_summary.json"),
  JSON.stringify(
    {
      score_dir: scoreDir,
      input: scoredCsv,
      reviewed: reviewed.length,
      tiers,
      chains,
      top20: reviewed.slice(0, 20).map((row) => ({
        rank: row.review_rank,
        code: row.code,
        name: row.name,
        market: row.market,
        chain: row.physical_ai_chain,
        tier: row.review_tier,
        reviewed_expected_value_score: Number(row.reviewed_expected_value_score),
        original_expected_value_score: Number(row.expected_value_score),
        reason: row.review_reason,
      })),
      note: "This is a first-pass theme-purity review, not company-by-company deep due diligence.",
    },
    null,
    2
  )
);

console.log(
  JSON.stringify(
    {
      reviewed: reviewed.length,
      tiers,
      top10: reviewed.slice(0, 10).map((row) => `${row.code} ${row.name} ${row.reviewed_expected_value_score} ${row.review_tier}`),
    },
    null,
    2
  )
);
