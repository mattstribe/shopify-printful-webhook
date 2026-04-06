import { listOrderLogs, getOrderLog } from "./order-log.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get("token");
  if (!token || token !== process.env.DEBUG_TOKEN) {
    return res.status(401).send("Unauthorized");
  }

  const order = url.searchParams.get("order");
  const date = url.searchParams.get("date");
  const key = url.searchParams.get("key");
  const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);

  try {
    if (key) {
      const log = await getOrderLog(key);
      return res.status(200).json(log);
    }

    const keys = await listOrderLogs({ order, date, limit });

    const summaries = [];
    if (url.searchParams.get("full") === "1") {
      for (const k of keys) {
        try {
          const log = await getOrderLog(k);
          summaries.push({ key: k, log });
        } catch (err) {
          summaries.push({ key: k, error: err.message });
        }
      }
      return res.status(200).json({ count: summaries.length, logs: summaries });
    }

    return res.status(200).json({
      count: keys.length,
      keys,
      hint: "Add &key=<key> to fetch a specific log, or &full=1 to fetch all contents inline.",
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
