// /api/printful-register-webhook.js
export default async function handler(req, res) {
  // Allow GET so you can just click it in the browser
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).send("Use GET or POST");
  }

  const storeId = Number(process.env.PRINTFUL_STORE_ID);
  const secret = process.env.PRINTFUL_WEBHOOK_SECRET || "";
  const baseUrl = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
  const url = `${baseUrl}/api/printful-webhook`;

  if (!storeId || !secret || !baseUrl) {
    return res.status(400).json({
      ok: false,
      missing: {
        PRINTFUL_STORE_ID: !!storeId,
        PRINTFUL_WEBHOOK_SECRET: !!secret,
        APP_BASE_URL: !!baseUrl,
      }
    });
  }

  try {
    const r = await fetch("https://api.printful.com/webhooks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PRINTFUL_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,                 // where Printful will POST
        secret,              // we’ll verify with this in /api/printful-webhook
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
