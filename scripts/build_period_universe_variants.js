#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const { parseCsv, writeCsv } = require("./lib/backtest_engine");

const DEFAULT_VARIANTS = [
  {
    name: "pitCacheA",
    theme: "pit_cache_a_share",
    dir: "pit_cache_a_share",
    markets: ["沪市", "深市", "北交所/新三板系"],
    description: "PIT cache A-share rows, including BJ/Neeq-style symbols when present.",
  },
  {
    name: "pitCacheAExBj",
    theme: "pit_cache_a_share_ex_bj",
    dir: "pit_cache_a_share_ex_bj",
    markets: ["沪市", "深市"],
    description: "PIT cache A-share rows excluding BJ/Neeq-style symbols.",
  },
  {
    name: "pitCacheSz",
    theme: "pit_cache_sz",
    dir: "pit_cache_sz",
    markets: ["深市"],
    description: "PIT cache Shenzhen-listed rows.",
  },
  {
    name: "pitCacheSh",
    theme: "pit_cache_sh",
    dir: "pit_cache_sh",
    markets: ["沪市"],
    description: "PIT cache Shanghai-listed rows.",
  },
  {
    name: "pitCacheHk",
    theme: "pit_cache_hk_connect",
    dir: "pit_cache_hk_connect",
    markets: ["港股通"],
    description: "PIT cache Hong Kong Stock Connect rows.",
  },
  {
    name: "pitCacheSzMain",
    theme: "pit_cache_sz_main",
    dir: "pit_cache_sz_main",
    variantKind: "board",
    markets: ["深市"],
    codePrefixes: ["000", "001", "002", "003"],
    description: "PIT cache Shenzhen main-board style rows, based on asOf market label and code prefix.",
  },
  {
    name: "pitCacheChiNext",
    theme: "pit_cache_chinext",
    dir: "pit_cache_chinext",
    variantKind: "board",
    markets: ["深市"],
    codePrefixes: ["300", "301"],
    description: "PIT cache ChiNext rows, based on asOf market label and code prefix.",
  },
  {
    name: "pitCacheShMain",
    theme: "pit_cache_sh_main",
    dir: "pit_cache_sh_main",
    variantKind: "board",
    markets: ["沪市"],
    codePrefixes: ["600", "601", "603", "605"],
    description: "PIT cache Shanghai main-board style rows, based on asOf market label and code prefix.",
  },
  {
    name: "pitCacheStar",
    theme: "pit_cache_star",
    dir: "pit_cache_star",
    variantKind: "board",
    markets: ["沪市"],
    codePrefixes: ["688", "689"],
    description: "PIT cache STAR Market rows, based on asOf market label and code prefix.",
  },
  {
    name: "pitCacheBj",
    theme: "pit_cache_bj",
    dir: "pit_cache_bj",
    variantKind: "board",
    markets: ["北交所/新三板系"],
    description: "PIT cache Beijing/Neeq-style rows, based on asOf market label.",
  },
];

function usage() {
  return [
    "Usage: node build_period_universe_variants.js --input-dir <period-universe-dir> --out-root <dir>",
    "",
    "Options:",
    "  --input-dir <dir>  Directory containing pit_universe_<YYYY-MM-DD>.csv files",
    "  --out-root <dir>   Output root for variant period-universe directories",
    "  --help",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    inputDir: "",
    outRoot: "",
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
    } else if (arg === "--input-dir") {
      args.inputDir = path.resolve(next());
    } else if (arg === "--out-root") {
      args.outRoot = path.resolve(next());
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!args.help && !args.inputDir) throw new Error("Missing --input-dir");
  if (!args.help && !args.outRoot) throw new Error("Missing --out-root");
  return args;
}

function parseHeaderLine(text) {
  const firstLine = String(text || "").split(/\n/, 1)[0] || "";
  return firstLine.split(",");
}

function loadPeriodUniverseFiles(inputDir) {
  if (!fs.existsSync(inputDir)) throw new Error(`Missing input dir: ${inputDir}`);
  return fs.readdirSync(inputDir)
    .map((file) => {
      const match = /^pit_universe_(20\d{2}-\d{2}-\d{2})\.csv$/.exec(file);
      if (!match) return null;
      const fullPath = path.join(inputDir, file);
      const text = fs.readFileSync(fullPath, "utf8");
      return {
        file: fullPath,
        basename: file,
        asOf: match[1],
        headers: parseHeaderLine(text),
        rows: parseCsv(text),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.asOf.localeCompare(b.asOf));
}

function normalizeMarket(value) {
  return String(value || "").trim();
}

function normalizeCode(value) {
  return String(value || "")
    .trim()
    .replace(/^(sh|sz|bj|hk)/i, "");
}

function variantReasonTag(variant) {
  return variant.variantKind === "board" ? "period_board_variant_v1" : "period_market_variant_v1";
}

function rowMatchesVariant(row, variant) {
  if (variant.markets?.length) {
    const marketSet = new Set(variant.markets.map(normalizeMarket));
    if (!marketSet.has(normalizeMarket(row.market))) return false;
  }
  if (variant.codePrefixes?.length) {
    const code = normalizeCode(row.code);
    if (!variant.codePrefixes.some((prefix) => code.startsWith(prefix))) return false;
  }
  return true;
}

function variantRow(row, variant) {
  const reasonTag = variantReasonTag(variant);
  return {
    ...row,
    theme: variant.theme,
    reason: [row.reason, `${reasonTag}:${variant.name}`].filter(Boolean).join(";"),
    source: [row.source, reasonTag].filter(Boolean).join("|"),
  };
}

function mergeHeaders(inputs) {
  const headers = [];
  const seen = new Set();
  for (const input of inputs) {
    for (const header of input.headers || []) {
      if (!header || seen.has(header)) continue;
      seen.add(header);
      headers.push(header);
    }
  }
  return headers;
}

function buildPeriodVariants(inputs, variantDefs = DEFAULT_VARIANTS) {
  const outputHeaders = mergeHeaders(inputs);
  const variants = variantDefs.map((variant) => {
    const files = inputs.map((input) => {
      const rows = input.rows
        .filter((row) => rowMatchesVariant(row, variant))
        .map((row) => variantRow(row, variant));
      return {
        asOf: input.asOf,
        basename: path.basename(input.file),
        rows,
        rowCount: rows.length,
      };
    });
    return {
      ...variant,
      files,
      asOfResults: files.map((file) => ({ asOf: file.asOf, file: file.basename, rowCount: file.rowCount })),
      totalRows: files.reduce((sum, file) => sum + file.rowCount, 0),
    };
  });
  return { outputHeaders, variants };
}

function run(args) {
  const inputs = loadPeriodUniverseFiles(args.inputDir);
  if (!inputs.length) throw new Error(`No pit_universe_<asOf>.csv files found in ${args.inputDir}`);
  fs.mkdirSync(args.outRoot, { recursive: true });

  const result = buildPeriodVariants(inputs);
  for (const variant of result.variants) {
    const dir = path.join(args.outRoot, variant.dir);
    fs.mkdirSync(dir, { recursive: true });
    for (const file of variant.files) {
      writeCsv(path.join(dir, file.basename), file.rows, result.outputHeaders);
    }
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    inputDir: args.inputDir,
    outRoot: args.outRoot,
    inputFileCount: inputs.length,
    inputFiles: inputs.map((input) => ({ asOf: input.asOf, file: path.basename(input.file), rowCount: input.rows.length })),
    pointInTimePolicy: "variants_preserve_each_input_asOf_membership",
    caveat: "Variants only split each PIT universe by the market label already present in that asOf file. They do not use future returns or post-asOf membership.",
    variants: result.variants.map((variant) => ({
      name: variant.name,
      dir: variant.dir,
      theme: variant.theme,
      variantKind: variant.variantKind || "market",
      markets: variant.markets,
      codePrefixes: variant.codePrefixes,
      description: variant.description,
      totalRows: variant.totalRows,
      asOfResults: variant.asOfResults,
    })),
  };
  fs.writeFileSync(path.join(args.outRoot, "period_variant_manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { outRoot: args.outRoot, manifest, variants: result.variants };
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      return;
    }
    const result = run(args);
    console.log(`Wrote ${result.manifest.variants.length} period-universe variants to ${result.outRoot}`);
    for (const variant of result.manifest.variants) {
      console.log(`${variant.name}: ${variant.totalRows} total rows -> ${variant.dir}`);
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
  buildPeriodVariants,
  loadPeriodUniverseFiles,
  parseArgs,
  run,
  rowMatchesVariant,
};
