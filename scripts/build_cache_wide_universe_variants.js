#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const { parseCsv, writeCsv } = require("./lib/backtest_engine");

const DEFAULT_VARIANTS = [
  {
    name: "cacheWideA",
    theme: "cache_wide_a_share",
    file: "cache_wide_a_share.csv",
    markets: ["沪市", "深市", "北交所/新三板系"],
    description: "A-share rows from the local cache-wide technical universe, including BJ/Neeq-style symbols.",
  },
  {
    name: "cacheWideAExBj",
    theme: "cache_wide_a_share_ex_bj",
    file: "cache_wide_a_share_ex_bj.csv",
    markets: ["沪市", "深市"],
    description: "A-share rows excluding BJ/Neeq-style symbols.",
  },
  {
    name: "cacheWideSz",
    theme: "cache_wide_sz",
    file: "cache_wide_sz.csv",
    markets: ["深市"],
    description: "Shenzhen-listed rows from the local cache-wide technical universe.",
  },
  {
    name: "cacheWideSh",
    theme: "cache_wide_sh",
    file: "cache_wide_sh.csv",
    markets: ["沪市"],
    description: "Shanghai-listed rows from the local cache-wide technical universe.",
  },
  {
    name: "cacheWideHk",
    theme: "cache_wide_hk_connect",
    file: "cache_wide_hk_connect.csv",
    markets: ["港股通"],
    description: "Hong Kong Stock Connect rows from the local cache-wide technical universe.",
  },
];

function usage() {
  return [
    "Usage: node build_cache_wide_universe_variants.js --input <cache_wide.csv> --out-dir <dir>",
    "",
    "Options:",
    "  --input <csv>       Cache-wide technical universe CSV",
    "  --out-dir <dir>     Output directory",
    "  --help",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    input: "",
    outDir: "",
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return argv[i];
    };
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--input") {
      args.input = path.resolve(next());
    } else if (arg === "--out-dir") {
      args.outDir = path.resolve(next());
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!args.help && !args.input) throw new Error("Missing --input");
  if (!args.help && !args.outDir) throw new Error("Missing --out-dir");
  return args;
}

function normalizeMarket(value) {
  return String(value || "").trim();
}

function variantRow(row, variant) {
  return {
    ...row,
    theme: variant.theme,
    reason: [row.reason, `market_variant_v1:${variant.name}`].filter(Boolean).join(";"),
    source: [row.source, "market_variant_v1"].filter(Boolean).join("|"),
  };
}

function buildVariants(rows, variantDefs = DEFAULT_VARIANTS) {
  const inputRows = Array.isArray(rows) ? rows : [];
  const result = {};
  for (const variant of variantDefs) {
    const marketSet = new Set(variant.markets.map(normalizeMarket));
    result[variant.name] = {
      ...variant,
      rows: inputRows
        .filter((row) => marketSet.has(normalizeMarket(row.market)))
        .map((row) => variantRow(row, variant)),
    };
  }
  return result;
}

function headersFor(rows) {
  const headers = [];
  const seen = new Set();
  for (const row of rows) {
    for (const header of Object.keys(row)) {
      if (seen.has(header)) continue;
      seen.add(header);
      headers.push(header);
    }
  }
  return headers;
}

function marketCounts(rows) {
  const counts = {};
  for (const row of rows) {
    const market = normalizeMarket(row.market) || "UNKNOWN";
    counts[market] = (counts[market] || 0) + 1;
  }
  return counts;
}

function run(args) {
  const text = fs.readFileSync(args.input, "utf8");
  const inputRows = parseCsv(text);
  const variants = buildVariants(inputRows);
  fs.mkdirSync(args.outDir, { recursive: true });

  const outputHeaders = headersFor(inputRows);
  const variantEntries = [];
  for (const variant of Object.values(variants)) {
    const filePath = path.join(args.outDir, variant.file);
    writeCsv(filePath, variant.rows, outputHeaders);
    variantEntries.push({
      name: variant.name,
      theme: variant.theme,
      file: variant.file,
      rowCount: variant.rows.length,
      markets: variant.markets,
      description: variant.description,
    });
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    input: args.input,
    inputRowCount: inputRows.length,
    inputMarketCounts: marketCounts(inputRows),
    pointInTimePolicy: "membership_split_uses_static_market_field_only",
    caveat: "These variants only split the already-built local cache universe by static market labels; they do not use future returns or post-asOf performance.",
    variants: variantEntries,
  };
  fs.writeFileSync(path.join(args.outDir, "variant_manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    outDir: args.outDir,
    manifest,
    variants,
  };
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      return;
    }
    const result = run(args);
    console.log(`Wrote ${result.manifest.variants.length} variants to ${result.outDir}`);
    for (const variant of result.manifest.variants) {
      console.log(`${variant.name}: ${variant.rowCount} rows -> ${variant.file}`);
    }
  } catch (error) {
    console.error(error.message);
    console.error("");
    console.error(usage());
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_VARIANTS,
  buildVariants,
  parseArgs,
  run,
};
