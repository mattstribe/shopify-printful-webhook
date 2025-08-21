import crypto from "crypto";
import { productColorSizeToVariant } from "./variant-map.js";

// (keep your existing helpers: shopDomain, getHandleByProductId, artUrlFromHandle, getRawBody, safeJson)
// and your file upload + order POST blocks

// before building the URL, sanitize the domain
function shopDomain() {
  return (process.env.SHOPIFY_STORE_DOMAIN || "")
    .replace(/^https?:\/\//, "")   // remove protocol if present
    .replace(/\/+$/, "");          // remove trailing slashes
}

// Parses "TEMPLATEID_PRODUCTCODE_COLOR_SIZE"
// Returns { templateId (number), variantKey: "PRODUCTCODE_COLOR_SIZE" }
function parseStructuredSku(rawSku = "") {
  // Normalize: trim, force uppercase
  const sku = String(rawSku).trim();
  const parts = sku.split("_");
  if (parts.length !== 4) return null;

  const [templateStr, productCode, color, size] = parts;
  const templateId = Number(templateStr);
  if (!Number.isFinite(templateId) || templateId <= 0) return null;

  const variantKey = [productCode, color, size].map(s => String(s).toUpperCase()).join("_");
  return { templateId, variantKey };
}

async function getHandleByProductId(id) {
  const url = `https://${shopDomain()}/admin/api/2025-01/products/${id}.json`;
  const r = await fetch(url, {
    headers: { "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN }
  });
  if (!r.ok) throw new Error(`Shopify get product ${id} failed: ${r.status}`);
  const { product } = await r.json();
  return product.handle;
}

function artUrlFromHandle(handle) {
  const base = (process.env.ART_BASE_URL || "").replace(/\/+$/, "");
  return `${base}/${handle}.png`; // <— flat files named exactly like the handle
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // ----- Read raw body for HMAC verification
  const raw = await getRawBody(req);
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  if (!hmacHeader) {
    console.error("[webhook] Missing HMAC header");
    return res.status(401).send("Missing HMAC");
  }

  const digest = crypto
    .createHmac("sha256", process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(raw, "utf8")
    .digest("base64");

  if (digest !== hmacHeader) {
    console.error("[webhook] HMAC validation failed");
    return res.status(401).send("HMAC validation failed");
  }

  // ----- Parse JSON safely
  let order;
  try {
    order = JSON.parse(raw);
  } catch (e) {
    console.error("[webhook] Invalid JSON:", e);
    return res.status(400).send("Invalid JSON");
  }

  // ----- Build recipient (fallbacks if missing)
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

  // ----- Map line items → Printful items
  const missing = [];
  const items = [];
  
  for (const li of (order.line_items || [])) {
    // --- Parse the structured SKU
    const parsed = parseStructuredSku(li?.sku);
    if (!parsed) {
      missing.push(li?.sku || `(no sku: ${li?.title})`);
      continue;
    }
  
    const { templateId, variantKey } = parsed;
  
    // --- Resolve catalog variant_id from PRODUCT_COLOR_SIZE
    const vId = productColorSizeToVariant[variantKey];
    if (!vId) {
      console.error("[map] No variant_id for", variantKey, "from SKU", li?.sku);
      missing.push(li?.sku || `(bad sku map: ${variantKey})`);
      continue;
    }
  
    // --- Get product handle
    let handle;
    try {
      handle = await getHandleByProductId(li.product_id); // e.g., "caribou-cup"
    } catch (e) {
      console.error("handle lookup failed", li.product_id, e);
      return res.status(200).json({ ok:false, reason:"handle_lookup_failed", product_id: li.product_id });
    }
  
    // --- Build art URL from handle and upload to Printful Files
    const fileUrl = artUrlFromHandle(handle);
    console.log("[debug] sku:", li?.sku, "| variantKey:", variantKey, "| templateId:", templateId, "| fileUrl:", fileUrl);
  
    const storeId = process.env.PRINTFUL_STORE_ID;
    if (!storeId) {
      console.error("[printful] Missing PRINTFUL_STORE_ID env");
      return res.status(200).json({ ok:false, reason:"missing_store_id_env" });
    }
  
    const fr = await fetch("https://api.printful.com/files", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PRINTFUL_API_TOKEN}`,
        "Content-Type": "application/json",
        "X-PF-Store-Id": storeId,
      },
      body: JSON.stringify({ url: fileUrl, store_id: Number(storeId) }),
    });
    const ft = await fr.text();
    console.log("[debug] files upload status:", fr.status, "| resp:", ft);
    if (!fr.ok) {
      console.error("[printful] file upload failed:", fr.status, ft);
      return res.status(200).json({
        ok:false, reason:"file_upload_failed", status: fr.status, handle, fileUrl, body: safeJson(ft)
      });
    }
    const fileRes = safeJson(ft);
    const fileId = fileRes?.result?.id;
  
    // --- Build the Printful item. Use BOTH: variant_id and template_id from SKU.
    items.push({
      variant_id: vId,                       // size + color (catalog variant)
      quantity: li.quantity ?? 1,
      template_id: templateId,               // placement/scale comes from the template
      files: [{ type: "default", id: fileId }]
    });
  }
  
  if (items.length === 0) {
    console.error("[webhook] No valid items. Missing SKUs:", missing);
    return res.status(200).json({ ok:false, reason:"No valid items", missing });
  }

  

  // ----- Build Printful order payload
  //const shouldConfirm = (process.env.PRINTFUL_CONFIRM || "true") === "true";
  
  const printfulOrder = {
    recipient,
    items,
    external_id: `shopify-${order.id}`, // useful to cross-reference
    shipping: "STANDARD",
    store_id: Number(process.env.PRINTFUL_STORE_ID),
    confirm: shouldConfirm,
  };

  // ----- Send to Printful
  try {
    const r = await fetch("https://api.printful.com/orders", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PRINTFUL_API_TOKEN}`,
        "Content-Type": "application/json",
        "X-PF-Store-Id": process.env.PRINTFUL_STORE_ID,
      },
      body: JSON.stringify(printfulOrder),
    });

    const text = await r.text();
    if (!r.ok) {
      console.error("[printful] Error:", r.status, text);
      // Return 200 so Shopify doesn’t retry. You can change to 500 if you want automatic retries.
      return res.status(200).json({ ok: false, printfulStatus: r.status, error: safeJson(text) });
    }

    const payload = safeJson(text);
    console.log("[printful] Order created:", payload?.result?.id ?? "(no id)", "for Shopify order", order.id);
    return res.status(200).json({ ok: true, printful: payload });
  } catch (err) {
    console.error("[printful] Network/Fetch failure:", err);
    return res.status(200).json({ ok: false, error: String(err) });
  }
}

// ---- helpers
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
function safeJson(text) {
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

