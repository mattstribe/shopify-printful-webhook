// /api/printful-webhook.js
import crypto from "crypto";
import { saveOrderLog } from "./order-log.js";

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

function secureEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function normalizePfSignature(sigHeader = "") {
  const raw = String(sigHeader || "").trim();
  if (!raw) return [];
  const tokens = raw
    .split(/[,\s]+/)
    .map(t => t.trim())
    .filter(Boolean)
    .map((t) => {
      const prefixed = t.match(/^(?:sha1|sha256|v1)=([a-f0-9+/=]+)$/i);
      return prefixed ? prefixed[1] : t;
    })
    .map(t => t.replace(/^"|"$/g, ""));
  return [...new Set(tokens)];
}

function verifySignature(headers, raw) {
  const sigHeader = String(headers["x-pf-signature"] || "");
  const secret = process.env.PRINTFUL_WEBHOOK_SECRET || "";
  if (!sigHeader || !secret) {
    return { ok: false, reason: "missing_header_or_secret", meta: { hasSigHeader: Boolean(sigHeader), hasSecret: Boolean(secret) } };
  }

  const provided = normalizePfSignature(sigHeader);
  const sha256Hex = crypto.createHmac("sha256", secret).update(raw, "utf8").digest("hex");
  const sha256Base64 = crypto.createHmac("sha256", secret).update(raw, "utf8").digest("base64");
  const sha1Hex = crypto.createHmac("sha1", secret).update(raw, "utf8").digest("hex");
  const expected = [sha256Hex, sha256Base64, sha1Hex];
  const ok = provided.some((p) => expected.some((e) => secureEqual(p, e)));

  return {
    ok,
    reason: ok ? "matched" : "mismatch",
    meta: {
      headerPreview: sigHeader.slice(0, 24),
      providedCount: provided.length,
      providedLens: provided.map(v => v.length),
      expectedLens: expected.map(v => v.length),
      bodyLength: raw.length,
    },
  };
}
function shopDomain() {
  return (process.env.SHOPIFY_STORE_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function extractShipments(body) {
  const sources = [
    body?.data?.shipments,
    body?.shipments,
    body?.data?.shipment ? [body.data.shipment] : null,
    body?.shipment ? [body.shipment] : null,
    body?.data?.order?.shipments,
    body?.order?.shipments,
  ];
  for (const src of sources) {
    if (Array.isArray(src) && src.length > 0) return src;
  }
  return [];
}

function normalizeTracking(shipment = {}, body = {}) {
  const number =
    shipment?.tracking_number ||
    shipment?.tracking_numbers?.[0] ||
    shipment?.trackingCode ||
    body?.data?.tracking_number ||
    body?.tracking_number ||
    "";
  const url =
    shipment?.tracking_url ||
    shipment?.tracking_urls?.[0] ||
    shipment?.trackingUrl ||
    body?.data?.tracking_url ||
    body?.tracking_url ||
    "";
  const company =
    shipment?.carrier ||
    shipment?.carrier_code ||
    shipment?.service ||
    shipment?.tracking_company ||
    body?.data?.carrier ||
    body?.carrier ||
    "Carrier";
  return { number: String(number || ""), url: String(url || ""), company: String(company || "Carrier") };
}

// --- Shopify helpers
async function getFulfillmentOrders(orderId) {
  const url = `https://${shopDomain()}/admin/api/2025-01/orders/${orderId}/fulfillment_orders.json`;
  const r = await fetch(url, {
    headers: { "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN },
  });
  if (!r.ok) throw new Error(`Fulfillment orders fetch failed: ${r.status}`);
  const { fulfillment_orders } = await r.json();
  return fulfillment_orders || [];
}

async function releaseFulfillmentHolds(fulfillmentOrders) {
  const released = [];
  for (const fo of fulfillmentOrders) {
    if (fo.status !== "on_hold") continue;
    try {
      const r = await fetch(
        `https://${shopDomain()}/admin/api/2025-01/fulfillment_orders/${fo.id}/release_hold.json`,
        {
          method: "POST",
          headers: { "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN },
        }
      );
      if (r.ok) released.push(fo.id);
      else console.warn(`[printful-webhook] release hold FO ${fo.id} failed: ${r.status}`);
    } catch (e) {
      console.warn(`[printful-webhook] release hold FO ${fo.id} error:`, e.message);
    }
  }
  return released;
}

async function updateExistingFulfillmentTracking(orderId, tracking) {
  const fRes = await fetch(
    `https://${shopDomain()}/admin/api/2025-01/orders/${orderId}/fulfillments.json`,
    { headers: { "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN } }
  );
  if (!fRes.ok) return { already_fulfilled: true, tracking_updated: false };
  const { fulfillments } = await fRes.json();
  const target = (fulfillments || []).find((f) => f.status === "success");
  if (!target) return { already_fulfilled: true, tracking_updated: false };

  const r = await fetch(
    `https://${shopDomain()}/admin/api/2025-01/fulfillments/${target.id}/update_tracking.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fulfillment: {
          tracking_info: {
            company: tracking?.company || "Carrier",
            number: tracking?.number || "",
            url: tracking?.url || "",
          },
          notify_customer: true,
        },
      }),
    }
  );
  const text = await r.text();
  if (!r.ok) throw new Error(`Shopify tracking update err ${r.status}: ${text}`);
  return { ...JSON.parse(text), tracking_updated: true };
}

async function createShopifyFulfillment({ orderId, tracking }) {
  const allFOs = await getFulfillmentOrders(orderId);

  const held = allFOs.filter((fo) => fo.status === "on_hold");
  if (held.length > 0) {
    await releaseFulfillmentHolds(held);
  }

  const refetchedFOs = held.length > 0 ? await getFulfillmentOrders(orderId) : allFOs;
  const openFOs = refetchedFOs.filter(
    (fo) => ["open", "in_progress", "scheduled"].includes(fo.status)
  );

  if (openFOs.length === 0) {
    console.log("[printful-webhook] no open FOs, updating tracking on existing fulfillment");
    return await updateExistingFulfillmentTracking(orderId, tracking);
  }

  const payload = {
    fulfillment: {
      line_items_by_fulfillment_order: openFOs.map((fo) => ({
        fulfillment_order_id: fo.id,
      })),
      tracking_info: {
        company: tracking?.company || "Carrier",
        number: tracking?.number || "",
        url: tracking?.url || "",
      },
      notify_customer: true,
    },
  };

  const url = `https://${shopDomain()}/admin/api/2025-01/fulfillments.json`;
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
  const url = new URL(req.url, `http://${req.headers.host}`);
  const debugBypass = url.searchParams.get("token") === process.env.DEBUG_TOKEN;
  const allowUnsigned = String(process.env.ALLOW_UNSIGNED_PRINTFUL_WEBHOOKS || "").toLowerCase() === "true";
  const sigCheck = verifySignature(req.headers, raw);

  if (!debugBypass && !allowUnsigned && !sigCheck.ok) {
    console.error("[printful-webhook] invalid signature", sigCheck.meta);
    return res.status(401).json({ ok: false, reason: "Invalid signature", meta: sigCheck.meta });
  }
  if (allowUnsigned && !sigCheck.ok) {
    console.warn("[printful-webhook] signature bypassed by ALLOW_UNSIGNED_PRINTFUL_WEBHOOKS");
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

  const trace = {
    received_at: new Date().toISOString(),
    source: "printful-webhook",
    event,
    external_id: ext,
    shopify_order_id: shopifyOrderId,
    signature_check: { ok: sigCheck.ok, reason: sigCheck.reason },
    steps: [],
    result: null,
  };

  const trackStep = (step) => {
    trace.steps.push(step);
    console.log("[printful-webhook][step]", JSON.stringify(step));
  };

  console.log("[printful-webhook]", { event, shopifyOrderId, ext });

  if (!/package_shipped|order_updated|order_fulfilled|order_in_process|order_packaged/i.test(event)) {
    trace.result = { ok: true, ignored: event };
    await saveOrderLog(trace);
    return res.status(200).json({ ok: true, ignored: event });
  }
  if (!shopifyOrderId) {
    trace.result = { ok: true, ignored: "no_external_id" };
    await saveOrderLog(trace);
    return res.status(200).json({ ok: true, ignored: "no_external_id" });
  }

  const shipments = extractShipments(body);
  const hasShipments = Array.isArray(shipments) && shipments.length > 0;
  trackStep({ type: "shipments_extracted", count: shipments.length, hasShipments });

  if (/order_in_process|order_packaged/i.test(event)) {
    trackStep({ type: "intermediate_event", event });
    trace.result = { ok: true, status: "acknowledged_intermediate" };
    await saveOrderLog(trace);
    return res.status(200).json({ ok: true, status: "acknowledged_intermediate" });
  }

  if (/package_shipped|order_fulfilled/i.test(event)) {
    if (!hasShipments) {
      trackStep({ type: "no_shipment_data", payloadKeys: Object.keys(body || {}), dataKeys: Object.keys(body?.data || {}) });
      trace.result = { ok: false, reason: "no_shipment_tracking_in_payload" };
      await saveOrderLog(trace);
      return res.status(200).json({ ok: false, reason: "no_shipment_tracking_in_payload" });
    }

    try {
      const results = [];
      for (const s of shipments) {
        const tracking = normalizeTracking(s, body);
        trackStep({
          type: "shipment_tracking_parsed",
          tracking_number: tracking.number || null,
          tracking_url: tracking.url || null,
          tracking_company: tracking.company || null,
        });
        const resp = await createShopifyFulfillment({
          orderId: shopifyOrderId,
          tracking,
        });
        trackStep({
          type: "shopify_fulfillment_created",
          already_fulfilled: resp?.already_fulfilled || false,
          fulfillment_id: resp?.fulfillment?.id || null,
          status: resp?.fulfillment?.status || null,
        });
        results.push(resp);
      }
      console.log("[printful-webhook] fulfillment(s) created successfully");
      trace.result = { ok: true, fulfillment_count: results.length };
      await saveOrderLog(trace);
      return res.status(200).json({ ok: true, fulfillments: results });
    } catch (e) {
      console.error("[printful-webhook] fulfillment create failed:", e);
      trackStep({ type: "fulfillment_error", error: String(e?.message || e) });
      trace.result = { ok: false, reason: "fulfillment_failed", error: String(e?.message || e) };
      await saveOrderLog(trace);
      return res.status(200).json({ ok: false, reason: "fulfillment_failed", error: String(e?.message || e) });
    }
  }

  trace.result = { ok: true, handled: event };
  await saveOrderLog(trace);
  return res.status(200).json({ ok: true, handled: event });
}
