export default async function handler(req, res) {
  // allow GET so you can click it; POST also works
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).send("Use GET or POST");
  }

  // Build a guaranteed absolute https URL for the webhook receiver
  // Priority: ?url=... (manual override) → APP_BASE_URL → infer from request headers
  const overrideUrl = req.query.url ? String(req.query.url) : "";
  const appBase =
    (process.env.APP_BASE_URL || "").replace(/\/+$/, ""); // no trailing slash

  // infer origin from request if needed
  const proto =
    (req.headers["x-forwarded-proto"] || "https").toString().split(",")[0].trim();
  const host = (req.headers.host || "").toString();

  const inferredBase = host ? `${proto}://${host}` : "";
  const base = overrideUrl || appBase || inferredBase;

  const webhookUrl = `${base}/api/printful-webhook`;

  // quick validation: must be absolute https
  const okUrl = /^https:\/\/[^ ]+$/i.test(webhookUrl);

  const storeId = Number(process.env.PRINTFUL_STORE_ID);
  const secret = process.env.PRINTFUL_WEBHOOK_SECRET || "";
  const token = process.env.PRINTFUL_API_TOKEN || process.env.PRINTFUL_API_KEY || "";

  if (!okUrl || !token || !storeId || !secret) {
    return res.status(400).json({
      ok: false,
      reason: "missing_or_bad_params",
      tried_webhookUrl: webhookUrl,
      checks: {
        webhookUrl_is_https_absolute: okUrl,
        PRINTFUL_API_TOKEN_present: !!token,
        PRINTFUL_STORE_ID_present: !!storeId,
        PRINTFUL_WEBHOOK_SECRET_present: !!secret,
      },
      tips: [
        "Set APP_BASE_URL to your deployed origin, e.g. https://shopify-printful-webhook.vercel.app",
        "Or pass ?url=https://your-domain to override for this call",
      ],
    });
  }

  try {
    const r = await fetch("https://api.printful.com/webhooks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: webhookUrl,
        secret,
        types: ["package_shipped", "order_updated"],
        store_id: storeId,
      }),
    });

    const text = await r.text();
    return res.status(r.ok ? 200 : 500).send(text);
  } catch (e) {
    return res.status(500).send(String(e));
  }
}
