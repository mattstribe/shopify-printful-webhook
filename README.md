# shopify-printful-webhook
shopify to printful webhook

## Generate Printful Variant Map Lines
Use this to fetch catalog `variant_id` values and print `variant-map.js` entries:

```bash
npm run printful:variants -- --product-id 71 --product-code BC3001
```

Optional color filter:

```bash
npm run printful:variants -- --product-id 71 --product-code BC3001 --color White
```

Required env var:

```bash
export PRINTFUL_API_TOKEN=your_token_here
```
