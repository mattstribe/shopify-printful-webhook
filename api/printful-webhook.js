// /api/printful-webhook.js
import crypto from "crypto";

// --- utils
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", c => (d += c));
    req.on("end", () => resolve(d));
    req.on("error", reject);
  });
}
function verifySignature(headers, raw) {
  const sig = String(headers["x-pf-signature"] || "");
  const secret = process.env.PRINTFUL_WEBHOOK_SECRET || "";
  if (!sig || !secret) return false;
  const digest = crypto.createHmac("sha256", secret).update(raw, "utf8").digest("hex");
  return sig.length === digest.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(digest));
}
function shopDomain() {
  return (process.env.SHOPIFY_STORE_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

// --- Shopify helpers (simple fulfillment by line_items)
async function getShopifyOrder(orderId) {
  const url = `https://${shopDomain()}/admin/api/2025-01/orders/${orderId}.json`;
  const r = await fetch(url, { headers: { "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN } });
  if (!r.ok) throw new Error(`Shopify get order ${orderId} failed: ${r.status}`);
  const { order } = await r.json();
  return order;
}
async function createShopifyFulfillment({ orderId, tracking, lineItemIds }) {
  const url = `https://${shopDomain()}/admin/api/2025-01/orders/${orderId}/fulfillments.json`;
  const payload = {
    fulfillment: {
      location_id: Number(process.env.SHOPIFY_LOCATION_ID),
      tracking_company: tracking?.company || tracking?.carrier || "Carrier",
      tracking_number: tracking?.number || "",
      tracking_urls: tracking?.url ? [tracking.url] : undefined,
      notify_customer: true,
      line_items: lineItemIds.map(id => ({ id })),
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

// --- handler
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const raw = await getRawBody(req);
  if (!verifySignature(req.headers, raw)) {
    console.error("[printful-webhook] invalid signature");
    return res.status(401).send("Invalid signature");
  }

  let body;
  try { body = JSON.parse(raw); } catch { return res.status(400).send("Invalid JSON"); }

  // Printful sends various shapes; we pull what we need robustly
  const event = body?.event || body?.type || "unknown";
  const ext = body?.data?.order?.external_id || body?.order?.external_id || body?.external_id || "";
  const m = String(ext).match(/^shopify-(\d+)$/);
  const shopifyOrderId = m ? m[1] : null;

  console.log("[printful-webhook]", { event, shopifyOrderId, ext });

  // We only act on shipment-ish events
  if (!/package_shipped|order_updated|order_fulfilled/i.test(event)) {
    return res.status(200).json({ ok: true, ignored: event });
  }
  if (!shopifyOrderId) {
    return res.status(200).json({ ok: true, ignored: "no_external_id" });
  }

  // Extract shipments + tracking
  const shipments = body?.data?.shipments || body?.shipments || [];
  if (!Array.isArray(shipments) || shipments.length === 0) {
    console.log("[printful-webhook] no shipments");
    return res.status(200).json({ ok: true, noShipments: true });
  }

  // Get fulfillable line items from Shopify order
  let order;
  try { order = await getShopifyOrder(shopifyOrderId); }
  catch (e) {
    console.error("[printful-webhook] fetch shopify order failed:", e);
    return res.status(200).json({ ok: false, reason: "shopify_fetch_failed" });
  }
  const fulfillable = (order.line_items || [])
    .filter(li => (li.fulfillable_quantity ?? 0) > 0)
    .map(li => li.id);
  if (fulfillable.length === 0) {
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
        lineItemIds: fulfillable,
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
