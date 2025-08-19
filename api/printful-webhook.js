// /api/printful-webhook.js  (ESM)
import crypto from "crypto";

// raw body for signature verification
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function verifySignature(headers, raw) {
  const sig = String(headers["x-pf-signature"] || headers["X-PF-Signature"] || "");
  const secret = process.env.PRINTFUL_WEBHOOK_SECRET || "";
  if (!sig || !secret) return false;
  const digest = crypto.createHmac("sha256", secret).update(raw, "utf8").digest("hex");
  // timingSafeEqual requires same-length buffers
  return sig.length === digest.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(digest));
}

function shopDomain() {
  return (process.env.SHOPIFY_STORE_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

// --- Shopify helpers
async function getShopifyOrder(orderId) {
  const url = `https://${shopDomain()}/admin/api/2025-01/orders/${orderId}.json`;
  const r = await fetch(url, { headers: { "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN } });
  if (!r.ok) throw new Error(`Shopify get order ${orderId} failed: ${r.status}`);
  const { order } = await r.json();
  return order;
}

// Create fulfillment by line_item IDs (simple path). If you prefer Fulfillment Orders API, we can switch later.
async function createShopifyFulfillment({ orderId, tracking, lineItemIds }) {
  const url = `https://${shopDomain()}/admin/api/2025-01/orders/${orderId}/fulfillments.json`;
  const payload = {
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
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Shopify fulfill err ${r.status}: ${text}`);
  return JSON.parse(text);
}

// Extract `shopify-<id>` we set in external_id when creating Printful orders
function extractShopifyId(payload) {
  const ext = payload?.data?.order?.external_id
           || payload?.order?.external_id
           || payload?.external_id
           || "";
  const m = String(ext).match(/^shopify-(\d+)$/);
  return m ? m[1] : null;
}

function shipmentsFrom(payload) {
  return payload?.data?.shipments || payload?.shipments || [];
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const raw = await getRawBody(req);
  if (!verifySignature(req.headers, raw)) {
    console.error("[printful-webhook] invalid signature");
    return res.status(401).send("Invalid signature");
  }

  let body;
  try { body = JSON.parse(raw); } catch { return res.status(400).send("Invalid JSON"); }

  const event = body?.event || body?.type || "unknown";
  const shopifyOrderId = extractShopifyId(body);
  console.log("[printful-webhook]", { event, shopifyOrderId });

  if (!shopifyOrderId) return res.status(200).json({ ok: true, ignored: "no_external_id" });

  const isShipmentEvent = /package_shipped|order_updated|order_fulfilled/i.test(event);
  if (!isShipmentEvent) return res.status(200).json({ ok: true, ignored: "event_not_shipment" });

  const shipments = shipmentsFrom(body);
  if (!Array.isArray(shipments) || shipments.length === 0) {
    console.log("[printful-webhook] no shipments");
    return res.status(200).json({ ok: true, noShipments: true });
  }

  let shopifyOrder;
  try {
    shopifyOrder = await getShopifyOrder(shopifyOrderId);
  } catch (e) {
    console.error("[printful-webhook] fetch shopify order failed:", e);
    return res.status(200).json({ ok: false, reason: "shopify_fetch_failed" });
  }

  const fulfillableLineItemIds = (shopifyOrder.line_items || [])
    .filter(li => (li.fulfillable_quantity ?? 0) > 0)
    .map(li => li.id);

  if (fulfillableLineItemIds.length === 0) {
    console.log("[printful-webhook] nothing fulfillable");
    return res.status(200).json({ ok: true, alreadyFulfilled: true });
  }

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
    console.log("[printful-webhook] fulfillment(s) created");
    return res.status(200).json({ ok: true, fulfillments: results });
  } catch (e) {
    console.error("[printful-webhook] fulfillment create failed:", e);
    return res.status(200).json({ ok: false, reason: "fulfillment_failed" });
  }
}
