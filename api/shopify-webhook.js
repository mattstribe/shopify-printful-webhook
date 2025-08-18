import crypto from "crypto";
import { skuToVariant } from "./sku-map.js";

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
  const items = (order.line_items || []).map((li) => {
    const vId = skuToVariant[li.sku];
    if (!vId) missing.push(li.sku || `(no sku: ${li.title})`);
    return vId
      ? { variant_id: vId, quantity: li.quantity ?? 1 }
      : null;
  }).filter(Boolean);

  if (items.length === 0) {
    console.error("[webhook] No items mapped. Missing SKUs:", missing);
    // 200 so Shopify doesn’t keep retrying forever; you’ll see the error in logs.
    return res.status(200).json({ ok: false, reason: "No mapped SKUs", missing });
  }
  if (missing.length) {
    console.warn("[webhook] Some SKUs missing mapping (order still forwarded):", missing);
  }

  // ----- Build Printful order payload
  const printfulOrder = {
    recipient,
    items,
    external_id: `shopify-${order.id}`, // useful to cross-reference
    shipping: "STANDARD",
    store_id: Number(process.env.PRINTFUL_STORE_ID),
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

