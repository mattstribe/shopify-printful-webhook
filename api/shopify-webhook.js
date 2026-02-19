import crypto from "crypto";
import sharp from "sharp";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
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
  if (parts.length < 4) return null;
  const templateRef = String(parts[0] || "").trim();
  const productCode = parts[1];
  const size = parts[parts.length - 1];
  const color = parts.slice(2, -1).join("_");
  if (!templateRef) return null;
  const normalize = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const variantKey = [productCode, color, size].map(normalize).join("_");
  return { templateRef, variantKey };
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

function placementArtUrl(templateRef, placement) {
  const base = (process.env.ART_BASE_URL || "").replace(/\/+$/, "");
  return `${base}/${templateRef}_${placement}.png`;
}

function compositePublicBaseUrl() {
  return (process.env.COMPOSITE_PUBLIC_BASE_URL || process.env.ART_BASE_URL || "").replace(/\/+$/, "");
}

function compositeUploadPluginId() {
  return process.env.COMPOSITE_UPLOAD_PLUGIN_ID || "variant-merch";
}

function numberArtUrl(templateRef, customNumber) {
  const base = (process.env.ART_BASE_URL || "").replace(/\/+$/, "");
  return `${base}/${templateRef}_${customNumber}.png`;
}

function configuredNumberKeys() {
  const raw = process.env.CUSTOM_NUMBER_FIELD_KEYS || "";
  return raw
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
}

function extractCustomNumberFromLineItem(li = {}) {
  const configuredKeys = configuredNumberKeys();
  const isNoneLikeValue = (v) => {
    const s = String(v ?? "").trim().toLowerCase();
    return s === "none" || s === "no" || s === "n/a" || s === "na";
  };
  const isNumberFieldName = (name) => /number|jersey|shirt|custom/i.test(name);
  const props = [
    ...(Array.isArray(li?.properties) ? li.properties : []),
    ...(Array.isArray(li?.custom_properties) ? li.custom_properties : []),
  ];

  for (const p of props) {
    const name = String(p?.name || p?.key || "").trim();
    const value = String(p?.value ?? "").trim();
    if (!name || !value) continue;
    const nameLc = name.toLowerCase();
    const isTargetField = configuredKeys.length > 0
      ? configuredKeys.includes(nameLc)
      : isNumberFieldName(name);
    if (!isTargetField) continue;
    if (isNoneLikeValue(value)) return null;
    if (/^\d+$/.test(value)) return value;
  }

  if (configuredKeys.length > 0) return null;
  for (const p of props) {
    const value = String(p?.value ?? "").trim();
    if (/^\d+$/.test(value)) return value;
  }
  return null;
}

function summarizeLineItemProperties(li = {}) {
  const props = [
    ...(Array.isArray(li?.properties) ? li.properties : []),
    ...(Array.isArray(li?.custom_properties) ? li.custom_properties : []),
  ];
  return props.map((p) => ({
    name: String(p?.name || p?.key || "").trim(),
    value: String(p?.value ?? "").trim(),
  }));
}

function sanitizeFilePart(value = "") {
  return String(value).toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function compositeFileName({ handle, templateRef, customNumber }) {
  const h = sanitizeFilePart(handle || "art");
  const t = sanitizeFilePart(templateRef || "template");
  const n = sanitizeFilePart(customNumber || "0");
  return `${h}__${t}__num-${n}.png`;
}

function deriveRemotePathFromSourceUrl(sourceUrl, fileName) {
  try {
    const u = new URL(sourceUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    parts.pop(); // drop source filename
    const prefix = parts.join("/");
    return prefix ? `${prefix}/${fileName}` : fileName;
  } catch {
    return fileName;
  }
}

async function fetchImageBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Image fetch failed (${r.status}) for ${url}`);
  const buf = await r.arrayBuffer();
  return Buffer.from(buf);
}

async function buildCompositePng({ baseUrl, overlayUrl }) {
  const [baseBuffer, overlayBuffer] = await Promise.all([
    fetchImageBuffer(baseUrl),
    fetchImageBuffer(overlayUrl),
  ]);
  return sharp(baseBuffer)
    .composite([{ input: overlayBuffer, left: 0, top: 0 }])
    .png()
    .toBuffer();
}

function r2Endpoint() {
  if (process.env.R2_ENDPOINT) return process.env.R2_ENDPOINT;
  const accountId = process.env.R2_ACCOUNT_ID || "";
  if (!accountId) return "";
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

function hasR2UploadConfig() {
  return Boolean(
    process.env.R2_BUCKET_NAME &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    r2Endpoint()
  );
}

async function uploadCompositeDirectToR2({ remotePath, pngBuffer }) {
  const endpoint = r2Endpoint();
  const bucket = process.env.R2_BUCKET_NAME || "";
  const key = String(remotePath || "").replace(/^\/+/, "");
  const client = new S3Client({
    region: process.env.R2_REGION || "auto",
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
    },
  });

  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: pngBuffer,
    ContentType: "image/png",
    CacheControl: "public, max-age=31536000, immutable",
  }));

  const publicBase = compositePublicBaseUrl();
  const normalizedPath = key.replace(/^\/+/, "");
  return {
    method: "r2_direct",
    endpoint,
    bucket,
    remote_path: normalizedPath,
    url: publicBase ? `${publicBase}/${normalizedPath}` : null,
  };
}

async function uploadCompositeViaApi({ fileName, remotePath, pngBuffer }) {
  const apiUrl = process.env.COMPOSITE_UPLOAD_API_URL || "";
  if (!apiUrl) return null;
  const publicBase = compositePublicBaseUrl();
  const normalizedRemotePath = String(remotePath || "").replace(/^\/+/, "");
  const pluginId = compositeUploadPluginId();
  const computedPublicUrl = publicBase ? `${publicBase}/${normalizedRemotePath}` : null;
  const r = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-File-Path": normalizedRemotePath,
      "X-File-Name": fileName,
      "X-Plugin-ID": pluginId,
    },
    body: pngBuffer,
  });
  const text = await r.text();
  const parsed = safeJsonParse(text);
  if (!r.ok) throw new Error(`Composite API upload failed (${r.status}): ${truncate(parsed)}`);
  const url = parsed?.url;
  return {
    upload_api_url: apiUrl,
    remote_path: remotePath,
    api_reported_url: typeof url === "string" && url ? url : null,
    url: computedPublicUrl || (typeof url === "string" && url ? url : null),
  };
}

async function uploadCompositeToCdn({ fileName, remotePath, pngBuffer }) {
  if (hasR2UploadConfig()) {
    return uploadCompositeDirectToR2({ remotePath, pngBuffer });
  }
  return uploadCompositeViaApi({ fileName, remotePath, pngBuffer });
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

function safeJsonParse(text) {
  try { return JSON.parse(text); }
  catch { return { raw: text }; }
}

function truncate(value, maxLen = 1200) {
  const str = typeof value === "string" ? value : JSON.stringify(value);
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen)}...[truncated]`;
}

function isPrintfulExternalIdDuplicate(payload) {
  const code = String(payload?.error?.api_error_code || "");
  if (code === "OR-13") return true;
  const msg = String(payload?.error?.message || payload?.result || "").toLowerCase();
  return msg.includes("external id already exists");
}

// ---- Main handler
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const raw = await getRawBody(req);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const debugToken = url.searchParams.get("token");
  const debugBypass = Boolean(debugToken && debugToken === process.env.DEBUG_TOKEN);
  const includeTraceInResponse = debugBypass || url.searchParams.get("trace") === "1";
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];

  if (!debugBypass) {
    if (!hmacHeader) return res.status(401).send("Missing HMAC");
    const digest = crypto.createHmac("sha256", process.env.SHOPIFY_WEBHOOK_SECRET)
      .update(raw, "utf8")
      .digest("base64");
    if (digest !== hmacHeader) return res.status(401).send("HMAC validation failed");
  }

  let order;
  try { order = JSON.parse(raw); } catch { return res.status(400).send("Invalid JSON"); }
  const trace = {
    received_at: new Date().toISOString(),
    debug_bypass: debugBypass,
    incoming: {
      shopify_topic: req.headers["x-shopify-topic"] || null,
      shopify_shop_domain: req.headers["x-shopify-shop-domain"] || null,
      shopify_order_id: order.id || null,
      order_number: order.order_number || null,
      line_item_count: (order.line_items || []).length,
      raw_preview: truncate(raw, 1800),
    },
    line_items: [],
    requests: [],
    missing: [],
    result: null,
  };
  console.log("[shopify-webhook] received order", {
    orderId: order.id,
    orderNumber: order.order_number,
    lineItemCount: (order.line_items || []).length,
  });

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

  const trackRequest = (entry) => {
    trace.requests.push(entry);
    console.log("[shopify-webhook][trace]", JSON.stringify(entry));
  };

  async function uploadFileToPrintfulTracked(fileUrl, context = {}) {
    const storeId = process.env.PRINTFUL_STORE_ID;
    const body = { url: fileUrl, store_id: Number(storeId) };
    const res = await fetch("https://api.printful.com/files", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PRINTFUL_API_TOKEN}`,
        "Content-Type": "application/json",
        "X-PF-Store-Id": storeId,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const parsed = safeJsonParse(text);
    trackRequest({
      type: "printful_file_upload",
      context,
      request: body,
      response_status: res.status,
      response_ok: res.ok,
      response_preview: truncate(parsed),
    });
    if (!res.ok) throw new Error(`Printful file upload failed: ${truncate(parsed)}`);
    return parsed?.result?.id;
  }

  for (const li of (order.line_items || [])) {
    console.log("[shopify-webhook] processing line item", {
      lineItemId: li?.id,
      sku: li?.sku,
      productId: li?.product_id,
      quantity: li?.quantity,
    });
    const parsed = parseStructuredSku(li?.sku);
    if (!parsed) {
      console.log("[shopify-webhook] invalid structured sku", li?.sku);
      missing.push(li?.sku || li.title);
      trace.line_items.push({
        sku: li?.sku || null,
        line_item_id: li?.id || null,
        product_id: li?.product_id || null,
        quantity: li?.quantity ?? 1,
        parse_ok: false,
      });
      continue;
    }

    const { templateRef, variantKey } = parsed;
    const vId = productColorSizeToVariant[variantKey];
    if (!vId) {
      console.log("[shopify-webhook] variant map miss", { sku: li?.sku, variantKey });
      missing.push(li?.sku || li.title);
      trace.line_items.push({
        sku: li?.sku || null,
        line_item_id: li?.id || null,
        product_id: li?.product_id || null,
        quantity: li?.quantity ?? 1,
        parse_ok: true,
        variant_key: variantKey,
        variant_id_found: false,
      });
      continue;
    }

    let handle;
    try {
      handle = await getHandleByProductId(li.product_id);
      trackRequest({
        type: "shopify_product_lookup",
        line_item_id: li?.id || null,
        product_id: li?.product_id || null,
        handle,
      });
    } catch (e) {
      console.error("handle lookup failed", li.product_id, e);
      missing.push(li?.sku || li.title);
      trace.line_items.push({
        sku: li?.sku || null,
        line_item_id: li?.id || null,
        product_id: li?.product_id || null,
        quantity: li?.quantity ?? 1,
        parse_ok: true,
        variant_key: variantKey,
        variant_id_found: true,
        variant_id: vId,
        product_handle_lookup_ok: false,
        error: String(e?.message || e),
      });
      continue;
    }

    try {
      // ---- Upload files first
      const mainArtUrl = artUrlFromHandle(handle);
      const customNumber = extractCustomNumberFromLineItem(li);
      let defaultArtUrl = mainArtUrl;
      console.log("[shopify-webhook] line item custom properties", {
        lineItemId: li?.id || null,
        sku: li?.sku || null,
        properties: summarizeLineItemProperties(li),
        extractedCustomNumber: customNumber || null,
      });
      if (customNumber) {
        const customNumberUrl = numberArtUrl(templateRef, customNumber);
        const numberHead = await fetch(customNumberUrl, { method: "HEAD" });
        trackRequest({
          type: "custom_number_head_check",
          line_item_id: li?.id || null,
          sku: li?.sku || null,
          custom_number: customNumber,
          url: customNumberUrl,
          response_status: numberHead.status,
          response_ok: numberHead.ok,
        });
        if (numberHead.ok) {
          const compositeName = compositeFileName({ handle, templateRef, customNumber });
          const remotePath = deriveRemotePathFromSourceUrl(mainArtUrl, compositeName);
          const compositeBuffer = await buildCompositePng({
            baseUrl: mainArtUrl,
            overlayUrl: customNumberUrl,
          });
          const uploadResult = await uploadCompositeToCdn({
            fileName: compositeName,
            remotePath,
            pngBuffer: compositeBuffer,
          });
          if (!uploadResult?.url) {
            throw new Error("Composite upload succeeded but no public URL was resolved");
          }
          trackRequest({
            type: "composite_created_uploaded",
            line_item_id: li?.id || null,
            sku: li?.sku || null,
            template_ref: templateRef,
            custom_number: customNumber,
            base_url: mainArtUrl,
            number_url: customNumberUrl,
            composite_file_name: compositeName,
            composite_remote_path: remotePath,
            composite_public_url: uploadResult.url,
            upload_method: uploadResult?.method || "api_proxy",
            upload_configured: hasR2UploadConfig() || Boolean(process.env.COMPOSITE_UPLOAD_API_URL),
          });
          defaultArtUrl = uploadResult.url;
        } else {
          trackRequest({
            type: "composite_skipped_missing_number_file",
            line_item_id: li?.id || null,
            sku: li?.sku || null,
            template_ref: templateRef,
            custom_number: customNumber,
            number_url: customNumberUrl,
          });
        }
      }
      const mainFileId = await uploadFileToPrintfulTracked(defaultArtUrl, {
        sku: li?.sku || null,
        line_item_id: li?.id || null,
        placement: "default",
        source: defaultArtUrl === mainArtUrl ? "base_art" : "composite_art",
      });

      const placementFiles = [];
      const placements = ["front", "back", "sleeve_left", "sleeve_right"];
      for (const placement of placements) {
        const placementUrl = placementArtUrl(templateRef, placement);
        const headRes = await fetch(placementUrl, { method: "HEAD" });
        trackRequest({
          type: "placement_head_check",
          line_item_id: li?.id || null,
          sku: li?.sku || null,
          placement,
          url: placementUrl,
          response_status: headRes.status,
          response_ok: headRes.ok,
        });
        if (headRes.ok) {
          try { 
            const fileId = await uploadFileToPrintfulTracked(placementUrl, {
              sku: li?.sku || null,
              line_item_id: li?.id || null,
              placement,
            });
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
        files: allFiles
      });
      trace.line_items.push({
        sku: li?.sku || null,
        line_item_id: li?.id || null,
        product_id: li?.product_id || null,
        quantity: li?.quantity ?? 1,
        parse_ok: true,
        variant_key: variantKey,
        variant_id_found: true,
        variant_id: vId,
        template_ref: templateRef,
        custom_number: customNumber || null,
        product_handle_lookup_ok: true,
        product_handle: handle,
        default_art_source: defaultArtUrl === mainArtUrl ? "base_art" : "composite_art",
        default_art_url: defaultArtUrl,
        file_count: allFiles.length,
      });
      console.log("[shopify-webhook] mapped line item", {
        sku: li?.sku,
        variantId: vId,
        templateRef,
        fileCount: allFiles.length,
      });

    } catch (e) {
      console.error("File upload failed for SKU", li?.sku, e.message);
      missing.push(li?.sku || li.title);
      trace.line_items.push({
        sku: li?.sku || null,
        line_item_id: li?.id || null,
        product_id: li?.product_id || null,
        quantity: li?.quantity ?? 1,
        parse_ok: true,
        variant_key: variantKey,
        variant_id_found: true,
        variant_id: vId,
        template_ref: templateRef,
        product_handle_lookup_ok: true,
        product_handle: handle,
        upload_ok: false,
        error: String(e?.message || e),
      });
      continue;
    }
  }
  trace.missing = missing;

  if (items.length === 0) {
    console.error("[shopify-webhook] no valid items", { missing, orderId: order.id });
    trace.result = { ok: false, reason: "No valid items" };
    console.log("[shopify-webhook][trace:summary]", JSON.stringify(trace));
    return res.status(200).json(includeTraceInResponse
      ? { ok:false, reason:"No valid items", missing, trace }
      : { ok:false, reason:"No valid items", missing }
    );
  }

  const draftOrder = {
    recipient,
    items,
    external_id: `NBHL${order.order_number || order.id}`,
    shipping: "STANDARD",
    store_id: Number(process.env.PRINTFUL_STORE_ID),
    confirm: false, // <-- create draft first
  };

  try {
    // ---- Step 1: Create draft
    trackRequest({
      type: "printful_order_create_request",
      request: draftOrder,
    });
    const r = await fetch("https://api.printful.com/orders", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PRINTFUL_API_TOKEN}`,
        "Content-Type": "application/json",
        "X-PF-Store-Id": process.env.PRINTFUL_STORE_ID,
      },
      body: JSON.stringify(draftOrder),
    });
    const draftText = await r.text();
    const draftPayload = safeJsonParse(draftText);
    trackRequest({
      type: "printful_order_create_response",
      response_status: r.status,
      response_ok: r.ok,
      response_preview: truncate(draftPayload),
    });
    if (!r.ok) {
      if (isPrintfulExternalIdDuplicate(draftPayload)) {
        trace.result = {
          ok: true,
          status: "already_exists",
          external_id: draftOrder.external_id,
          printful_error_code: draftPayload?.error?.api_error_code || null,
        };
        console.log("[printful] duplicate external_id treated as success", {
          externalId: draftOrder.external_id,
          code: draftPayload?.error?.api_error_code || null,
        });
        console.log("[shopify-webhook][trace:summary]", JSON.stringify(trace));
        return res.status(200).json(includeTraceInResponse
          ? { ok: true, already_exists: true, external_id: draftOrder.external_id, missing, trace }
          : { ok: true, already_exists: true, external_id: draftOrder.external_id, missing }
        );
      }
      throw new Error(`Draft order create failed (${r.status}): ${JSON.stringify(draftPayload)}`);
    }
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
    const confirmText = await confirmRes.text();
    const confirmPayload = safeJsonParse(confirmText);
    trackRequest({
      type: "printful_order_confirm_response",
      printful_order_id: orderId,
      response_status: confirmRes.status,
      response_ok: confirmRes.ok,
      response_preview: truncate(confirmPayload),
    });
    if (!confirmRes.ok) {
      throw new Error(`Draft confirm failed (${confirmRes.status}): ${JSON.stringify(confirmPayload)}`);
    }
    console.log("[printful] Order confirmed:", confirmPayload?.result?.id);
    trace.result = { ok: true, printful_order_id: confirmPayload?.result?.id || orderId };
    console.log("[shopify-webhook][trace:summary]", JSON.stringify(trace));
    return res.status(200).json(includeTraceInResponse
      ? { ok: true, draft: draftPayload, confirmed: confirmPayload, missing, trace }
      : { ok: true, draft: draftPayload, confirmed: confirmPayload, missing }
    );

  } catch (err) {
    console.error("[printful] Order creation/confirmation failed:", err);
    trace.result = { ok: false, error: String(err) };
    console.log("[shopify-webhook][trace:summary]", JSON.stringify(trace));
    return res.status(200).json(includeTraceInResponse
      ? { ok: false, error: String(err), missing, trace }
      : { ok: false, error: String(err), missing }
    );
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
