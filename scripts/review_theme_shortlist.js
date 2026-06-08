#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { defaultOutputRoot } = require("./lib/paths");

const scoreDir = process.argv[2] || path.join(defaultOutputRoot(), "theme-score-20260604-1715");
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

function n(x) {
  const y = Number(x);
  return Number.isFinite(y) ? y : 0;
}

const strong = {
  "AIDC电力液冷": {
    "002837": "液冷温控核心",
    "301018": "数据中心温控/液冷",
    "300499": "液冷散热",
    "300990": "工业/储能温控",
    "002518": "UPS/数据中心电源",
    "002335": "数据中心电源",
    "300693": "电力电子/充电/储能",
    "002364": "HVDC/电源系统",
    "688719": "电力电子设备",
    "300286": "企业微电网/用电管理",
    "601126": "电网自动化/保护控制",
    "002028": "输配电设备出海",
    "688676": "变压器/AIDC/出海",
    "002270": "分接开关/电力设备出海",
    "603556": "智能电表出海",
    "002851": "电源/电力电子/AIDC",
    "002463": "AI服务器PCB，偏AIDC硬件",
    "300476": "AI服务器PCB，偏AIDC硬件",
  },
  "先进封装HBM存储国产化": {
    "002409": "半导体材料/HBM配套",
    "600584": "封测龙头",
    "002156": "封测龙头",
    "002185": "封测",
    "688362": "封测",
    "688535": "先进封装材料",
    "002436": "封装基板/PCB",
    "002916": "封装基板/高速PCB",
    "002463": "高速PCB/AI服务器",
    "688008": "HBM接口芯片",
    "688525": "存储模组/国产存储",
    "301308": "存储模组",
    "603986": "存储芯片",
    "688123": "存储接口/EEPROM",
    "688110": "存储芯片",
    "002371": "半导体设备",
    "688012": "半导体设备",
    "688072": "先进制程/封装设备",
    "688082": "半导体设备",
    "300604": "半导体测试设备",
    "688200": "测试设备",
  },
  "创新药出海": {
    "600276": "创新药平台/出海潜力",
    "688506": "ADC/创新药BD核心",
    "688331": "ADC/创新药平台",
    "002422": "ADC/创新药BD平台",
    "06990": "港股通ADC平台",
    "09926": "双抗/全球数据驱动",
    "06160": "全球化创新药平台",
    "01801": "创新药平台",
    "01276": "港股通恒瑞",
    "09995": "港股通荣昌",
    "02315": "抗体发现平台",
    "09606": "ADC新上市弹性",
    "00013": "全球化创新药",
    "06855": "血液肿瘤/BD潜力",
    "09688": "全球化商业化平台",
    "02162": "双抗/创新药平台",
  },
  "具身智能机器人": {
    "002050": "机器人热管理/执行器产业链",
    "601689": "机器人执行器/汽车底盘外溢",
    "688017": "谐波减速器",
    "002472": "精密传动",
    "002896": "减速器/传动",
    "603728": "电机",
    "603662": "力传感器",
    "300007": "传感器",
    "688320": "伺服/控制",
    "688160": "运动控制",
    "002747": "工业机器人/运动控制",
    "300124": "伺服/控制龙头",
    "002979": "运动控制",
    "003021": "微型传动",
    "603667": "轴承/丝杠链",
    "300580": "丝杠链",
    "603009": "丝杠链",
    "301413": "传感器",
    "688322": "3D视觉",
    "09880": "港股通整机",
    "09660": "机器人AI/控制平台",
    "02018": "声学/触觉/精密硬件",
    "02382": "机器视觉/光学",
  },
  固态电池: {
    "300037": "电解液/固态体系材料",
    "301238": "锂盐/电解质材料",
    "300438": "电芯验证弹性",
    "002167": "锆材料/固态电解质",
    "603663": "锆材料/固态电解质",
    "603200": "材料验证",
    "300750": "电芯龙头",
    "03750": "港股通宁德",
    "002460": "锂资源/固态布局",
    "01772": "港股通赣锋",
    "002074": "电芯",
    "300014": "电芯",
    "688499": "锂电设备",
    "832522": "北交所锂电设备",
    "603659": "负极/材料体系",
    "002709": "电解液",
  },
  "商业航天卫星互联网": {
    "688333": "3D打印/航天制造",
    "688066": "卫星应用",
    "688523": "航天结构件",
    "300762": "军工通信",
    "688270": "射频芯片",
    "688311": "卫星通信",
    "600118": "卫星制造",
    "300455": "航天电子",
    "600879": "航天电子",
    "002025": "航天连接器",
    "002151": "北斗导航",
    "300101": "北斗芯片",
    "002465": "通信/北斗",
    "002446": "卫星通信",
    "688568": "空天信息",
    "02357": "港股通中航科工",
  },
  核聚变核能: {
    "688122": "高温超导",
    "688776": "微波/真空/核聚变设备链",
    "001280": "铀资源",
    "01164": "港股通铀资源",
    "601985": "核电运营",
    "003816": "核电运营",
    "600875": "核电设备",
    "601727": "核电设备",
    "002318": "核级管材",
    "603169": "能源装备",
    "603699": "阀门",
    "603308": "高端铸件",
    "000969": "材料",
    "600353": "电子管/聚变相关弹性",
    "600363": "激光/超导概念",
  },
  "低空经济eVTOL": {
    "002085": "飞行汽车/整机链",
    "000099": "低空运营",
    "001696": "航空动力",
    "002625": "复材/超材料",
    "600580": "电驱",
    "688631": "低空空管",
    "301091": "交通低空基础设施",
    "300284": "低空基础设施",
    "688070": "无人机",
    "688297": "无人机",
    "600038": "直升机",
    "09868": "港股通eVTOL整车预期",
    "02357": "港股通航空制造",
  },
  "稳定币RWA数字金融": {
    "300468": "跨境金融IT/香港稳定币弹性",
    "300465": "金融IT",
    "300348": "银行IT",
    "300674": "银行IT",
    "003040": "数字货币硬件",
    "002104": "支付安全",
    "000997": "支付终端",
    "300773": "支付",
    "300130": "支付",
    "600570": "金融IT",
    "00388": "港股通交易所/RWA基础设施",
    "01788": "港股通券商",
    "06060": "港股通互联网保险/金融科技",
    "01357": "港股通Web3/RWA事件弹性",
    "02388": "港股通银行跨境结算",
    "02888": "港股通银行跨境结算",
    "00005": "港股通银行跨境结算",
  },
  "AI Agent垂直应用": {
    "002230": "AI平台/教育办公",
    "688111": "AI办公付费场景",
    "300418": "AI应用/海外流量",
    "300624": "AI创作软件",
    "300229": "知识检索/政企AI",
    "300170": "企业软件Agent",
    "300378": "工业软件Agent",
    "600588": "企业软件Agent",
    "301236": "大模型实施/政企软件",
    "600845": "工业软件/数据中心",
    "002315": "B2B外贸AI",
    "300364": "内容语料/AI阅读",
    "00700": "港股通入口平台",
    "09988": "港股通云+入口",
    "03888": "港股通办公软件",
    "03896": "港股通云",
    "00020": "港股通AI平台",
    "09678": "港股通语音AI",
  },
};

const downgrade = {
  "AIDC电力液冷": {
    "600522": "更偏通信/电缆，AIDC电力液冷纯度不足",
    "300001": "更偏充电网，数据中心电力纯度不足且短期涨幅大",
    "00992": "更偏AI硬件整机，非电力液冷核心",
    "01347": "半导体制造，不是AIDC电力液冷核心",
  },
  "先进封装HBM存储国产化": {
    "02382": "光学硬件，不是先进封装/HBM核心",
    "603031": "电池属性更强，半导体纯度不足",
    "600667": "封装厂房/工程属性，核心壁垒弱于设备材料封测",
  },
  "创新药出海": {
    "688131": "偏药物发现工具/CXO，出海创新药弹性弱于BD资产端",
    "002821": "CXO属性更强，创新药出海弹性间接",
    "603259": "CXO属性更强，赔率取决于行业复苏而非单品出海",
    "02269": "CXO/生物药外包属性更强",
    "02359": "CXO属性更强",
  },
  "具身智能机器人": {
    "601609": "铜加工材料属性更强，机器人纯度不足",
    "00992": "AI硬件整机趋势强，但机器人纯度不足",
    "00300": "家电龙头，机器人弹性不够集中",
  },
  固态电池: {
    "002245": "锂电/消费电池属性较宽，固态核心度不足",
    "603663": "主题弹性强但估值/波动已高",
    "03750": "龙头确定性强，但多倍赔率弱于小中盘材料设备",
  },
  "商业航天卫星互联网": {
    "00763": "通信设备龙头，卫星互联网纯度间接",
    "00941": "运营商属性强，商业航天弹性不足",
    "00728": "运营商属性强，卫星互联网弹性不足",
    "00788": "铁塔基础设施，弹性不足",
  },
  核聚变核能: {
    "600522": "通信/电缆属性更强，核聚变纯度不足",
    "000543": "电力运营，核聚变弹性不足",
    "600023": "电力运营，核聚变弹性不足",
    "002859": "非核心核聚变链，短线趋势驱动更重",
  },
  "低空经济eVTOL": {
    "300975": "电子分销属性较强，eVTOL纯度不足且涨幅过大",
    "00763": "通信设备，低空经济纯度间接",
    "00285": "电子制造，低空经济纯度间接",
    "01211": "整车龙头，低空弹性不集中",
  },
  "稳定币RWA数字金融": {
    "600999": "券商低估值但稳定币弹性不直接",
    "601688": "券商低估值但稳定币弹性不直接",
    "601211": "券商低估值但稳定币弹性不直接",
    "601995": "券商低估值但稳定币弹性不直接",
    "600030": "券商低估值但稳定币弹性不直接",
  },
  "AI Agent垂直应用": {
    "000681": "版权/内容数据更强，Agent付费闭环弱",
    "00992": "硬件趋势强，AI Agent应用纯度不足",
    "300182": "影视版权属性，Agent纯度不足",
    "002174": "游戏属性，Agent纯度不足",
  },
};

function manualPurity(row) {
  const themeStrong = strong[row.theme] || {};
  const themeDown = downgrade[row.theme] || {};
  if (themeStrong[row.code]) return { score: 95, tag: "强核心", note: themeStrong[row.code] };
  if (themeDown[row.code]) return { score: 38, tag: "降权", note: themeDown[row.code] };
  if (row.relevance && row.relevance.includes("核心")) return { score: 76, tag: "一般核心", note: "接口/人工核心但需进一步验证" };
  return { score: 58, tag: "相关", note: "主题相关但非强核心" };
}

function reviewed(row) {
  const m = manualPurity(row);
  const overheat =
    n(row.ret20) > 60 || n(row.ret60) > 120 || n(row.pct_chg) > 12
      ? 8
      : n(row.ret20) > 35 || n(row.ret60) > 80
        ? 4
        : 0;
  const valuationRisk = n(row.pe) > 150 || n(row.pb) > 18 ? 5 : 0;
  const score =
    0.30 * n(row.value_bet_score) +
    0.22 * n(row.short_term_score) +
    0.20 * n(row.alpha_score) +
    0.24 * m.score -
    overheat -
    valuationRisk;
  return {
    ...row,
    manual_purity_score: m.score.toFixed(1),
    review_tag: m.tag,
    review_note: m.note,
    reviewed_score: Math.max(0, Math.min(100, score)).toFixed(1),
    review_penalty: (overheat + valuationRisk).toFixed(1),
  };
}

const rows = parseCsv(fs.readFileSync(scoredCsv, "utf8")).map(reviewed);
const sorted = [...rows].sort((a, b) => n(b.reviewed_score) - n(a.reviewed_score) || n(b.value_bet_score) - n(a.value_bet_score));

const cols = [
  "theme", "code", "name", "market", "industry", "review_tag", "reviewed_score",
  "expected_value_score", "alpha_score", "value_bet_score", "short_term_score",
  "manual_purity_score", "review_penalty", "review_note", "price", "pct_chg",
  "amount", "pe", "pb", "ret20", "ret60", "drawdown60", "risks", "source"
];
writeCsv("reviewed_candidates.csv", sorted.map((r, i) => ({ rank: i + 1, ...r })), ["rank", ...cols]);

const byTheme = [];
for (const theme of [...new Set(rows.map((r) => r.theme))]) {
  sorted.filter((r) => r.theme === theme).slice(0, 20).forEach((r, i) => byTheme.push({ theme_rank: i + 1, ...r }));
}
writeCsv("reviewed_top_by_theme.csv", byTheme, ["theme_rank", ...cols]);

const downgraded = rows
  .filter((r) => r.review_tag === "降权")
  .sort((a, b) => n(b.expected_value_score) - n(a.expected_value_score));
writeCsv("downgraded_after_review.csv", downgraded, cols);

const summary = {
  generated_at: new Date().toISOString(),
  input: scoredCsv,
  reviewed_rows: rows.length,
  formula: "reviewed_score = 0.30*value_bet + 0.22*short_term + 0.20*alpha + 0.24*manual_theme_purity - overheat_penalty - valuation_penalty",
  by_theme: Object.fromEntries([...new Set(rows.map((r) => r.theme))].map((theme) => {
    const arr = sorted.filter((r) => r.theme === theme);
    return [theme, arr.slice(0, 10).map((r) => ({
      code: r.code,
      name: r.name,
      market: r.market,
      reviewed_score: n(r.reviewed_score),
      value_bet_score: n(r.value_bet_score),
      short_term_score: n(r.short_term_score),
      tag: r.review_tag,
      note: r.review_note,
    }))];
  })),
  top30: sorted.slice(0, 30).map((r) => ({
    theme: r.theme,
    code: r.code,
    name: r.name,
    market: r.market,
    reviewed_score: n(r.reviewed_score),
    value_bet_score: n(r.value_bet_score),
    short_term_score: n(r.short_term_score),
    tag: r.review_tag,
    note: r.review_note,
  })),
};
fs.writeFileSync(path.join(scoreDir, "review_summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
