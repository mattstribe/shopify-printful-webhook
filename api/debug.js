// /api/debug.js
import crypto from "crypto";
import { productColorSizeToVariant } from "./variant-map.js";

function parseStructuredSku(rawSku = "") {
  const sku = String(rawSku).trim();
  const parts = sku.split("_");
  if (parts.length < 4) return null;
  const templateRef = String(parts[0] || "").trim();
  const productCode = parts[1];
  const size = parts[parts.length - 1];
  const color = parts.slice(2, -1).join("_");
  if (!templateRef) return null;
  const normalize = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return {
    templateRef,
    variantKey: [productCode, color, size].map(normalize).join("_"),
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const raw = await getRawBody(req);

  // ---- HMAC verification (unless you pass ?token=DEBUG_TOKEN)
  const url = new URL(req.url, `http://${req.headers.host}`);
  const bypass = url.searchParams.get("token");
  if (!bypass || bypass !== process.env.DEBUG_TOKEN) {
    const hmacHeader = req.headers["x-shopify-hmac-sha256"];
    if (!hmacHeader) return res.status(401).send("Missing HMAC");

    const digest = crypto
      .createHmac("sha256", process.env.SHOPIFY_WEBHOOK_SECRET)
      .update(raw, "utf8")
      .digest("base64");

    if (digest !== hmacHeader) return res.status(401).send("HMAC validation failed");
  }

  // ---- Parse Shopify order
  let order;
  try { order = JSON.parse(raw); }
  catch { return res.status(400).send("Invalid JSON"); }

  // ---- Build recipient
  const sa = order.shipping_address || order.customer?.default_address || {};
  const recipient = {
    name: [sa.first_name, sa.last_name].filter(Boolean).join(" ") || order.customer?.first_name || "Customer",
    address1: sa.address1 || "N/A",
    city: sa.city || "N/A",
    state_code: sa.province_code || sa.province || "",
    country_code: sa.country_code || sa.country || "US",
    zip: sa.zip || "",
    email: order.email || "",
    phone: sa.phone || order.customer?.phone || "",
  };

  // ---- Map items
  const missing = [];
  const mappedItems = (order.line_items || []).map((li) => {
    const parsed = parseStructuredSku(li?.sku);
    const vId = parsed ? productColorSizeToVariant[parsed.variantKey] : undefined;
    if (!vId) missing.push(li?.sku || `(no sku: ${li?.title})`);
    return vId ? {
      variant_id: vId,
      quantity: li.quantity ?? 1,
      _sku: li.sku,
      _variant_key: parsed?.variantKey,
      _template_ref: parsed?.templateRef
    } : null;
  }).filter(Boolean);

  const printfulOrder = {
    recipient,
    items: mappedItems.map(({ _sku, ...rest }) => rest),
    external_id: `shopify-${order.id}`,
    shipping: "STANDARD",
    ...(process.env.PRINTFUL_STORE_ID ? { store_id: Number(process.env.PRINTFUL_STORE_ID) } : {}),
  };

  // ---- Return a safe preview (nothing is sent to Printful here)
  return res.status(200).json({
    ok: true,
    note: "This is a DRY-RUN preview. Nothing was sent to Printful.",
    mapped_items: mappedItems,        // includes _sku for your reference
    missing_skus: missing,
    printful_payload: printfulOrder,  // what /orders would receive
    env: {
      has_token: Boolean(process.env.PRINTFUL_API_TOKEN),
      store_id: process.env.PRINTFUL_STORE_ID || null,
    },
  });
}

// helpers
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
