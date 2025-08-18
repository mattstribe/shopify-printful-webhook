export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");
  return res.status(200).json({
    ok: true,
    service: "shopify-printful-webhook",
    time: new Date().toISOString(),
  });
}
