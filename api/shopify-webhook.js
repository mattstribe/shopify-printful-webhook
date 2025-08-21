import crypto from "crypto";
import { productColorSizeToVariant } from "./variant-map.js";

// ---- Helpers
function shopDomain() {
  return (process.env.SHOPIFY_STORE_DOMAIN || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
}

function parseStructuredSku(rawSku = "") {
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
  return `${base}/${handle}.png`;
}

function placementArtUrl(templateId, placement) {
  const base = (process.env.ART_BASE_URL || "").replace(/\/+$/, "");
  return `${base}/${templateId}_${placement}.png`;
}

async function uploadFileToPrintful(fileUrl) {
  const storeId = process.env.PRINTFUL_STORE_ID;
  const res = await fetch("https://api.printful.com/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.PRINTFUL_API_TOKEN}`,
      "Content-Type": "application/json",
      "X-PF-Store-Id": storeId,
    },
    body: JSON.stringify({ url: fileUrl, store_id: Number(storeId) }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Printful file upload failed: ${JSON.stringify(data)}`);
  return data?.result?.id;
}

// ---- Main handler
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const raw = await getRawBody(req);
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  if (!hmacHeader) return res.status(401).send("Missing HMAC");

  const digest = crypto.createHmac("sha256", process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(raw, "utf8")
    .digest("base64");
  if (digest !== hmacHeader) return res.status(401).send("HMAC validation failed");

  let order;
  try { order = JSON.parse(raw); } catch { return res.status(400).send("Invalid JSON"); }

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

  const items = [];
  const missing = [];

  for (const li of (order.line_items || [])) {
    const parsed = parseStructuredSku(li?.sku);
    if (!parsed) { missing.push(li?.sku || li.title); continue; }

    const { templateId, variantKey } = parsed;
    const vId = productColorSizeToVariant[variantKey];
    if (!vId) { missing.push(li?.sku || li.title); continue; }

    let handle;
    try { handle = await getHandleByProductId(li.product_id); } catch (e) {
      console.error("handle lookup failed", li.product_id, e);
      return res.status(200).json({ ok:false, reason:"handle_lookup_failed" });
    }

    try {
      // ---- Upload files first
      const mainFileId = await uploadFileToPrintful(artUrlFromHandle(handle));

      const placementFiles = [];
      const placements = ["front", "back", "sleeve_left", "sleeve_right"];
      for (const placement of placements) {
        const placementUrl = placementArtUrl(templateId, placement);
        const headRes = await fetch(placementUrl, { method: "HEAD" });
        if (headRes.ok) {
          try { 
            const fileId = await uploadFileToPrintful(placementUrl);
            placementFiles.push({ type: placement, id: fileId });
          } catch (e) {
            console.log("Placement upload failed:", placement, e.message);
          }
        }
      }

      const allFiles = [{ type: "default", id: mainFileId }, ...placementFiles];
      items.push({
        variant_id: vId,
        quantity: li.quantity ?? 1,
        template_id: templateId,
        files: allFiles
      });

    } catch (e) {
      console.error("File upload failed for SKU", li?.sku, e.message);
      missing.push(li?.sku || li.title);
      continue;
    }
  }

  if (items.length === 0) return res.status(200).json({ ok:false, reason:"No valid items", missing });

  const draftOrder = {
    recipient,
    items,
    external_id: `NBHL-${order.order_number || order.id}`,
    shipping: "STANDARD",
    store_id: Number(process.env.PRINTFUL_STORE_ID),
    confirm: false, // <-- create draft first
  };

  try {
    // ---- Step 1: Create draft
    const r = await fetch("https://api.printful.com/orders", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PRINTFUL_API_TOKEN}`,
        "Content-Type": "application/json",
        "X-PF-Store-Id": process.env.PRINTFUL_STORE_ID,
      },
      body: JSON.stringify(draftOrder),
    });
    const draftPayload = await r.json();
    const orderId = draftPayload?.result?.id;

    if (!orderId) throw new Error("Draft order creation failed");

    // ---- Step 2: Confirm the draft
    const confirmRes = await fetch(`https://api.printful.com/orders/${orderId}/confirm`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PRINTFUL_API_TOKEN}`,
        "X-PF-Store-Id": process.env.PRINTFUL_STORE_ID,
      },
    });
    const confirmPayload = await confirmRes.json();
    console.log("[printful] Order confirmed:", confirmPayload?.result?.id);

    return res.status(200).json({ ok: true, draft: draftPayload, confirmed: confirmPayload, missing });

  } catch (err) {
    console.error("[printful] Order creation/confirmation failed:", err);
    return res.status(200).json({ ok: false, error: String(err), missing });
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
