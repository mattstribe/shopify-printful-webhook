import {
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const LOG_PREFIX = "_logs";

function r2Endpoint() {
  if (process.env.R2_ENDPOINT) return process.env.R2_ENDPOINT;
  const accountId = process.env.R2_ACCOUNT_ID || "";
  return accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "";
}

function hasR2Config() {
  return Boolean(
    process.env.R2_BUCKET_NAME &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    r2Endpoint()
  );
}

function makeClient() {
  return new S3Client({
    region: process.env.R2_REGION || "auto",
    endpoint: r2Endpoint(),
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
    },
  });
}

/**
 * Persist the full trace object to R2 so it can be inspected later.
 * Key format: _logs/YYYY-MM-DD/order_{orderNumber}_{timestamp}.json
 * Fails silently — order processing should never break because of logging.
 */
export async function saveOrderLog(trace) {
  if (!hasR2Config()) {
    console.warn("[order-log] R2 not configured — skipping log persistence");
    return;
  }
  try {
    const now = new Date();
    const dateDir = now.toISOString().slice(0, 10);
    const orderNum = trace?.incoming?.order_number ?? trace?.incoming?.shopify_order_id ?? "unknown";
    const ts = now.toISOString().replace(/[:.]/g, "-");
    const key = `${LOG_PREFIX}/${dateDir}/order_${orderNum}_${ts}.json`;

    const client = makeClient();
    await client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: JSON.stringify(trace, null, 2),
      ContentType: "application/json",
    }));
    console.log("[order-log] saved", key);
  } catch (err) {
    console.error("[order-log] failed to save log:", err.message);
  }
}

/**
 * List log keys, optionally filtered to a single order number.
 * Returns newest-first (by key name which embeds the timestamp).
 */
export async function listOrderLogs({ order, date, limit = 50 } = {}) {
  const client = makeClient();
  let prefix = `${LOG_PREFIX}/`;
  if (date) prefix += `${date}/`;

  const res = await client.send(new ListObjectsV2Command({
    Bucket: process.env.R2_BUCKET_NAME,
    Prefix: prefix,
    MaxKeys: 500,
  }));

  let keys = (res.Contents || []).map((o) => o.Key).filter(Boolean);
  if (order) {
    const needle = `order_${order}_`;
    keys = keys.filter((k) => k.includes(needle));
  }

  keys.sort().reverse();
  return keys.slice(0, limit);
}

/** Fetch a single log file from R2 and return the parsed JSON. */
export async function getOrderLog(key) {
  const client = makeClient();
  const res = await client.send(new GetObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
  }));
  const text = await res.Body.transformToString();
  return JSON.parse(text);
}
