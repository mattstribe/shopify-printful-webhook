#!/usr/bin/env node

const API_BASE = "https://api.printful.com";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) continue;
    const key = raw.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function usage() {
  console.log(
    [
      "Usage:",
      "  npm run printful:variants -- --product-id 71 --product-code BC3001",
      "",
      "Options:",
      "  --product-id <id>       Printful catalog product ID (required)",
      "  --product-code <code>   Left-side prefix for keys (required), e.g. BC3001",
      "  --color <name>          Optional exact color filter (case-insensitive), e.g. White",
      "",
      "Env:",
      "  PRINTFUL_API_TOKEN      Required Bearer token",
    ].join("\n")
  );
}

function normalizeSize(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9]/g, "");
}

const KNOWN_COLOR_CODES = {
  WHITE: "WHT",
  BLACK: "BLK",
  RED: "RED",
  BLUE: "BLU",
  NAVY: "NVY",
  PINK: "PNK",
  GREEN: "GRN",
  YELLOW: "YLW",
  ORANGE: "ORG",
  PURPLE: "PRP",
  BROWN: "BRN",
  GREY: "GRY",
  GRAY: "GRY",
  BEIGE: "BEI",
  MAROON: "MAR",
};

function normalizeColor(value) {
  const upper = String(value || "").toUpperCase().trim();
  if (!upper) return "UNK";

  if (KNOWN_COLOR_CODES[upper]) return KNOWN_COLOR_CODES[upper];

  const words = upper
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) return "UNK";
  if (words.length === 1) return words[0].slice(0, 3).padEnd(3, "X");

  return words
    .slice(0, 3)
    .map((w) => w[0])
    .join("");
}

async function getProduct(productId, token) {
  const res = await fetch(`${API_BASE}/products/${productId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Printful API error ${res.status}: ${JSON.stringify(data)}`);
  }
  return data?.result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    usage();
    return;
  }

  const token = process.env.PRINTFUL_API_TOKEN || "";
  const productId = Number(args["product-id"]);
  const productCode = String(args["product-code"] || "").toUpperCase().trim();
  const colorFilter = args.color ? String(args.color).toLowerCase().trim() : "";

  if (!token) {
    console.error("Missing PRINTFUL_API_TOKEN.");
    usage();
    process.exitCode = 1;
    return;
  }
  if (!Number.isFinite(productId) || productId <= 0) {
    console.error("Missing or invalid --product-id.");
    usage();
    process.exitCode = 1;
    return;
  }
  if (!productCode) {
    console.error("Missing --product-code.");
    usage();
    process.exitCode = 1;
    return;
  }

  const product = await getProduct(productId, token);
  const variants = Array.isArray(product?.variants) ? product.variants : [];

  const selected = colorFilter
    ? variants.filter((v) => String(v?.color || "").toLowerCase() === colorFilter)
    : variants;

  if (selected.length === 0) {
    console.log("No variants found for given filters.");
    return;
  }

  console.log(`// ${product?.brand || ""} ${product?.model || ""} ${product?.type || ""}`.trim());
  for (const v of selected) {
    const colorCode = normalizeColor(v?.color);
    const sizeCode = normalizeSize(v?.size);
    const key = `${productCode}_${colorCode}_${sizeCode}`;
    const name = String(v?.name || "").replace(/\s+/g, " ").trim();
    console.log(`"${key}": ${v.id}, // ${name}`);
  }
}

main().catch((err) => {
  console.error(err.message || String(err));
  process.exitCode = 1;
});
