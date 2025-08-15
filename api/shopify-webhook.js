import crypto from 'crypto';

/**
 * Vercel serverless function to handle Shopify order webhooks and forward
 * them to Printful as manual store orders. See README for configuration details.
 *
 * Shopify will POST order data to this endpoint. We verify the HMAC using
 * the shared secret, map line items to Printful variant IDs, assemble the
 * recipient details, and send a Printful order via their public API.
 */
export default async function handler(req, res) {
  // Only accept POST requests from Shopify
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    // Shopify signs the raw request body with your webhook secret. We need
    // the unparsed body to recreate the signature and verify the request.
    const rawBody = await getRawBody(req);

    const hmacHeader = req.headers['x-shopify-hmac-sha256'];
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
    if (!secret) {
      console.warn('SHOPIFY_WEBHOOK_SECRET is not set');
      return res.status(500).send('Server misconfiguration');
    }

    // Recompute the HMAC using the secret and raw request body
    const digest = crypto
      .createHmac('sha256', secret)
      .update(rawBody, 'utf8')
      .digest('base64');

    if (digest !== hmacHeader) {
      console.warn('Invalid webhook signature');
      return res.status(401).send('Invalid HMAC signature');
    }

    // Parse the body once we've validated the signature. The body is JSON.
    const order = JSON.parse(rawBody);

    // Map SKUs from Shopify to Printful variant IDs. Adjust this mapping
    // to match your actual product catalog in Printful. Each key here
    // corresponds to a Shopify variant SKU (case-sensitive).
    const skuToVariantId = {
      'SKU-001': 0, // Replace 0 with a real Printful variant ID
      'SKU-002': 0
      // ...add more mappings as needed
    };

    // Build order line items for Printful. If a SKU is unmapped, we will
    // skip it entirely. You may want to throw instead, depending on your
    // business logic.
    const items = order.line_items
      .map((li) => {
        const variantId = skuToVariantId[li.sku];
        if (!variantId) {
          console.warn(`No Printful variant mapping for SKU ${li.sku}`);
          return null;
        }
        return {
          variant_id: variantId,
          quantity: li.quantity
        };
      })
      .filter(Boolean);

    if (items.length === 0) {
      console.warn('No valid items to send to Printful');
      return res.status(200).send('No items forwarded');
    }

    // Extract recipient info from the shipping address. Assumes orders are
    // shipping (not local pickup). Adjust to your needs.
    const shipping = order.shipping_address;
    const recipient = {
      name: `${shipping.first_name} ${shipping.last_name}`.trim(),
      address1: shipping.address1,
      city: shipping.city,
      state_code: shipping.province_code || shipping.province,
      country_code: shipping.country_code || shipping.country,
      zip: shipping.zip,
      email: order.email || shipping.phone || '',
      phone: shipping.phone || ''
    };

    // Construct the payload for Printful
    const printfulOrder = {
      recipient,
      items
    };

    // Send the order to Printful
    const apiToken = process.env.PRINTFUL_API_TOKEN;
    if (!apiToken) {
      console.warn('PRINTFUL_API_TOKEN environment variable missing');
      return res.status(500).send('Server misconfiguration');
    }

    const printfulResponse = await fetch('https://api.printful.com/orders', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(printfulOrder)
    });

    if (!printfulResponse.ok) {
      const errorText = await printfulResponse.text();
      console.error('Printful API error', errorText);
      return res.status(502).send('Failed to forward order to Printful');
    }

    // All good
    return res.status(200).send('Order forwarded to Printful');
  } catch (err) {
    console.error('Webhook handler error', err);
    return res.status(500).send('Internal Server Error');
  }
}

/**
 * Read the raw body from the Node.js request stream. Vercel does not
 * provide the body as a Buffer by default, so we manually assemble it.
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<string>}
 */
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      resolve(data);
    });
    req.on('error', (err) => {
      reject(err);
    });
  });
}
