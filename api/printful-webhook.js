// /api/printful-webhook.js
import crypto from "crypto";

async function findShopifyOrderIdByName(name) {
  const url = `https://${shopDomain()}/admin/api/2025-01/orders.json?status=any&name=${encodeURIComponent(name)}`;
  const r = await fetch(url, {
    headers: { "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN }
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Order lookup by name failed: ${r.status} ${JSON.stringify(data)}`);
  const order = (data?.orders || [])[0];
  return order?.id || null;
}

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

// --- Shopify helpers
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

// --- Mark order status helpers
async function markOrderStatus(orderId, status) {
  const url = `https://${shopDomain()}/admin/api/2025-01/orders/${orderId}.json`;
  const payload = { order: { id: orderId, fulfillment_status: status } };
  const r = await fetch(url, {
    method: "PUT",
    headers: {
      "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  if (!r.ok) console.error(`Shopify mark ${status} failed:`, text);
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

  const event = body?.event || body?.type || "unknown";
  const ext = body?.data?.order?.external_id || body?.order?.external_id || body?.external_id || "";

  let shopifyOrderId = null;
  const m = String(ext).match(/^shopify-(\d+)$/i);
  if (m) shopifyOrderId = m[1];
  if (!shopifyOrderId) {
    const byName = await findShopifyOrderIdByName(ext);
    if (byName) shopifyOrderId = byName;
    else {
      const m2 = String(ext).match(/^NBHL(\d+)$/i);
      if (m2) {
        const altName = `#${m2[1]}`;
        shopifyOrderId = await findShopifyOrderIdByName(altName);
      }
    }
  }

  console.log("[printful-webhook]", { event, shopifyOrderId, ext });

  // Only handle fulfillment-related events
  if (!/package_shipped|order_updated|order_fulfilled|order_in_process|order_packaged/i.test(event)) {
    return res.status(200).json({ ok: true, ignored: event });
  }
  if (!shopifyOrderId) {
    return res.status(200).json({ ok: true, ignored: "no_external_id" });
  }

  const shipments = body?.data?.shipments || body?.shipments || [];
  const hasShipments = Array.isArray(shipments) && shipments.length > 0;

  // Get order
  let order;
  try { order = await getShopifyOrder(shopifyOrderId); }
  catch (e) {
    console.error("[printful-webhook] fetch shopify order failed:", e);
    return res.status(200).json({ ok: false, reason: "shopify_fetch_failed" });
  }

  const fulfillable = (order.line_items || [])
    .filter(li => (li.fulfillable_quantity ?? 0) > 0)
    .map(li => li.id);

  // --- Handle intermediate stages
  if (/order_in_process|order_packaged/i.test(event)) {
    await markOrderStatus(shopifyOrderId, "in_progress");
    console.log("[printful-webhook] marked order in progress");
    return res.status(200).json({ ok: true, status: "in_progress" });
  }

  // --- Handle shipped/fulfilled
  if (/package_shipped|order_fulfilled/i.test(event)) {
    if (fulfillable.length === 0) {
      console.log("[printful-webhook] nothing fulfillable");
      await markOrderStatus(shopifyOrderId, "fulfilled");
      return res.status(200).json({ ok: true, alreadyFulfilled: true });
    }

    try {
      const results = [];
      if (hasShipments) {
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
      }
      await markOrderStatus(shopifyOrderId, "fulfilled");
      console.log("[printful-webhook] fulfillment(s) created + order marked fulfilled");
      return res.status(200).json({ ok: true, fulfillments: results });
    } catch (e) {
      console.error("[printful-webhook] fulfillment create failed:", e);
      return res.status(200).json({ ok: false, reason: "fulfillment_failed" });
    }
  }

  return res.status(200).json({ ok: true, handled: event });
}
