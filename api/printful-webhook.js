// /api/printful-webhook.js  (ESM, Vercel serverless)
import crypto from "crypto";

// ——— raw body helper (so HMAC matches exactly)
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// ——— verify Printful signature
function verifyPrintfulSignature(raw) {
  const sig = (this.headers?.["x-pf-signature"] || this.headers?.["X-PF-Signature"] || "").toString();
  const secret = process.env.PRINTFUL_WEBHOOK_SECRET || "";
  if (!sig || !secret) return false;
  const digest = crypto.createHmac("sha256", secret).update(raw, "utf8").digest("hex");
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(digest));
}

// ——— shop domain sanitize
function shopDomain() {
  return (process.env.SHOPIFY_STORE_DOMAIN || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
}

// ——— Shopify helpers
async function getShopifyOrder(orderId) {
  const url = `https://${shopDomain()}/admin/api/2025-01/orders/${orderId}.json`;
  const r = await fetch(url, {
    headers: { "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN }
  });
  if (!r.ok) throw new Error(`Shopify get order ${orderId} failed: ${r.status}`);
  const { order } = await r.json();
  return order;
}

async function createShopifyFulfillment({ orderId, tracking, lineItemIds }) {
  const url = `https://${shopDomain()}/admin/api/2025-01/orders/${orderId}/fulfillments.json`;
  const body = {
    fulfillment: {
      location_id: Number(process.env.SHOPIFY_LOCATION_ID),
      tracking_company: tracking?.company || tracking?.carrier || "Carrier",
      tracking_number: tracking?.number || "",
      tracking_urls: tracking?.url ? [tracking.url] : undefined,
      line_items: lineItemIds.map(id => ({ id })),
      notify_customer: true,
    },
  };
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Shopify fulfill err ${r.status}: ${text}`);
  return JSON.parse(text);
}

// ——— extractors tolerant to Printful payload shapes
function getExternalId(payload) {
  // we set external_id = "shopify-<id>" when creating the order
  const ext = payload?.data?.order?.external_id
           || payload?.order?.external_id
           || payload?.external_id
           || "";
  const m = String(ext).match(/^shopify-(\d+)$/);
  return m ? m[1] : null;
}

function getShipments(payload) {
  // typical: payload.data.shipments[…]
  return payload?.data?.shipments
      || payload?.shipments
      || [];
}

// ——— main handler
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const raw = await getRawBody(req);
  // bind headers to verify function
  const verify = verifyPrintfulSignature.bind({ headers: req.headers });
  if (!verify(raw)) {
    console.error("[pf-webhook] bad signature");
    return res.status(401).send("Invalid signature");
  }

  let body;
  try { body = JSON.parse(raw); }
  catch { return res.status(400).send("Invalid JSON"); }

  const event = body?.event || body?.type || "unknown";
  const shopifyOrderId = getExternalId(body);

  console.log("[pf-webhook] event:", event, "external shopify id:", shopifyOrderId);

  // We care about shipments
  if (!shopifyOrderId) {
    console.warn("[pf-webhook] missing external_id → cannot map to Shopify order");
    return res.status(200).json({ ok: true, ignored: true });
  }

  // Only react on package shipped / order updated with shipments
  const isShipmentEvent = /package_shipped|order_updated|order_fulfilled/i.test(event);
  if (!isShipmentEvent) {
    return res.status(200).json({ ok: true, ignored: true });
  }

  const shipments = getShipments(body);
  if (!Array.isArray(shipments) || shipments.length === 0) {
    console.log("[pf-webhook] no shipments attached; nothing to do");
    return res.status(200).json({ ok: true, noShipments: true });
  }

  // Fetch Shopify order to get fulfillable line_item IDs
  let shopifyOrder;
  try {
    shopifyOrder = await getShopifyOrder(shopifyOrderId);
  } catch (e) {
    console.error("[pf-webhook] cannot fetch Shopify order:", e);
    return res.status(200).json({ ok: false, reason: "shopify_fetch_failed" });
  }

  // Choose line items that still need fulfillment
  const fulfillableLineItemIds = (shopifyOrder.line_items || [])
    .filter(li => (li.fulfillable_quantity ?? 0) > 0)
    .map(li => li.id);

  if (fulfillableLineItemIds.length === 0) {
    console.log("[pf-webhook] nothing fulfillable for Shopify order", shopifyOrderId);
    return res.status(200).json({ ok: true, alreadyFulfilled: true });
  }

  // Create one fulfillment per shipment (you could also group)
  try {
    const results = [];
    for (const s of shipments) {
      const tracking = {
        number: s?.tracking_number || s?.tracking_numbers?.[0] || "",
        url: s?.tracking_url || s?.tracking_urls?.[0] || "",
        company: s?.carrier || s?.carrier_code || s?.service || "Carrier",
      };
      const resp = await createShopifyFulfillment({
        orderId: shopifyOrderId,
        tracking,
        lineItemIds: fulfillableLineItemIds,
      });
      results.push(resp);
    }
    console.log("[pf-webhook] fulfillments created for order", shopifyOrderId);
    return res.status(200).json({ ok: true, fulfillments: results });
  } catch (e) {
    console.error("[pf-webhook] fulfillment create failed:", e);
    return res.status(200).json({ ok: false, reason: "fulfillment_failed" });
  }
}
