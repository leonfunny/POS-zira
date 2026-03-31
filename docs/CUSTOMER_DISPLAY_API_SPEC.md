# Customer Display - Backend API Specification

> Endpoints needed by Print Agent to power the customer-facing display (promo carousel + bestseller showcase).

## Overview

The Print Agent customer display has two content sources:
1. **Promo images** - Banner images configured in the dashboard
2. **Bestseller products** - Top-selling products with images/prices, auto-generated from sales data

Both endpoints are called every **5 minutes** by the Print Agent and cached locally.

---

## Endpoint 1: Promo Images

```
GET /api/v1/print-agent/promo-images
Authorization: Bearer <JWT>
```

### Response `200 OK`

```json
{
  "images": [
    "https://cdn.enail.pro/salons/abc123/promo/banner1.jpg",
    "https://cdn.enail.pro/salons/abc123/promo/summer-sale.webp"
  ]
}
```

### Logic

1. Extract `salonId` from JWT token
2. Query promotional banner images configured in salon dashboard
3. Return public CDN URLs (no auth required to fetch the images themselves)
4. Return empty array `[]` if no promo images configured

### Notes

- Images should be public URLs - the Electron app loads them directly in an `<img>` tag
- Supported formats: `.jpg`, `.png`, `.webp`
- Recommended resolution: 1920x1080 (display is fullscreen)
- Return order = display order (first image shows first)

---

## Endpoint 2: Bestseller Products

```
GET /api/v1/print-agent/bestsellers
Authorization: Bearer <JWT>
```

### Query Parameters

| Param    | Type   | Default | Description                              |
|----------|--------|---------|------------------------------------------|
| `limit`  | number | `10`    | Max products to return (1-20)            |
| `days`   | number | `30`    | Sales window in days (7, 30, 90, 365)    |

### Response `200 OK`

```json
{
  "products": [
    {
      "id": "uuid-variant-1",
      "name": "Manicure hybrydowy",
      "sku": "SRV-001",
      "price": 8000,
      "originalPrice": 10000,
      "currency": "PLN",
      "imageUrl": "https://cdn.enail.pro/salons/abc123/products/manicure.jpg",
      "badge": "bestseller",
      "totalSold": 142,
      "inStock": true
    },
    {
      "id": "uuid-variant-2",
      "name": "OPI Nail Lacquer - Big Apple Red",
      "sku": "NL-N25",
      "price": 4500,
      "originalPrice": null,
      "currency": "PLN",
      "imageUrl": "https://cdn.enail.pro/salons/abc123/products/opi-red.jpg",
      "badge": null,
      "totalSold": 98,
      "inStock": true
    }
  ],
  "generatedAt": "2026-02-01T06:00:00Z"
}
```

### Field Descriptions

| Field           | Type          | Description                                        |
|-----------------|---------------|----------------------------------------------------|
| `id`            | string (UUID) | Product variant ID                                 |
| `name`          | string        | Display name                                       |
| `sku`           | string        | SKU code                                           |
| `price`         | number        | Current price in grosze (8000 = 80.00 PLN)         |
| `originalPrice` | number\|null  | Original price before discount (null = no discount)|
| `currency`      | string        | ISO currency code from salon settings              |
| `imageUrl`      | string\|null  | Product image URL (public CDN, no auth)            |
| `badge`         | string\|null  | `"bestseller"`, `"new"`, `"sale"`, or null         |
| `totalSold`     | number        | Units sold in the `days` window                    |
| `inStock`       | boolean       | Whether product is currently available              |

### Logic (SQL reference)

```sql
SELECT
  pv.id,
  pv.name,
  pv.sku,
  pv.list_price AS price,
  pv.image_url,
  ve.badges,
  SUM(oi.quantity) AS total_sold,
  COALESCE(sq.quantity - sq.reserved_quantity, 0) > 0 AS in_stock
FROM order_items oi
  JOIN product_variants pv ON oi.variant_id = pv.id
  LEFT JOIN variant_ecommerce ve ON ve.variant_id = pv.id AND ve.salon_id = pv.salon_id
  LEFT JOIN stock_quants sq ON sq.variant_id = pv.id
WHERE pv.salon_id = :salonId
  AND pv.is_active = true
  AND oi.item_type = 'PRODUCT'
  AND oi.created_at >= NOW() - INTERVAL ':days days'
GROUP BY pv.id, pv.name, pv.sku, pv.list_price, pv.image_url, ve.badges, sq.quantity, sq.reserved_quantity
ORDER BY total_sold DESC
LIMIT :limit
```

### Edge Cases

- New salon with no orders -> return empty `products: []`
- Product was deleted after being sold -> skip it (JOIN filters it out)
- Product has no image -> return `imageUrl: null` (frontend shows placeholder)
- Services (item_type = 'SERVICE') should also be included for salon mode

### Caching

- Cache per `salonId` for **5 minutes** (Print Agent polls every 5 min)
- Invalidate on new order completion (optional, not critical)
- Use existing `ai-recommendation.service.ts` cache pattern

---

## Endpoint 3: Combined Display Content (Optional)

> Single endpoint that returns both promo images and bestsellers in one call. Reduces from 2 API calls to 1.

```
GET /api/v1/print-agent/display-content
Authorization: Bearer <JWT>
```

### Response `200 OK`

```json
{
  "promoImages": [
    "https://cdn.enail.pro/salons/abc123/promo/banner1.jpg"
  ],
  "bestsellers": [
    {
      "id": "uuid",
      "name": "Manicure hybrydowy",
      "price": 8000,
      "imageUrl": "https://cdn.enail.pro/salons/abc123/products/manicure.jpg",
      "totalSold": 142
    }
  ],
  "salonName": "Beauty Studio",
  "salonLogo": "https://cdn.enail.pro/salons/abc123/logo.png",
  "currency": "PLN",
  "generatedAt": "2026-02-01T06:00:00Z"
}
```

---

## Implementation Guide

### Where to Add

| What | File |
|------|------|
| Controller | `backend/src/modules/print-agent/controllers/print-agent.controller.ts` |
| Service | `backend/src/modules/print-agent/services/print-agent.service.ts` |
| Reuse | `backend/src/modules/ecommerce/services/ai-recommendation.service.ts` (getPopularProducts) |

### Existing Code to Reuse

The `AiRecommendationService.getPopularProducts()` already does 90% of the work:
- Groups `order_items` by `variantId`
- Counts total sold quantity
- Includes stock levels
- Caches for 1 hour

**Recommended approach**: Call `getPopularProducts()` from the new print-agent endpoint, then map the response to add `price`, `originalPrice`, `currency`, `inStock`, and `badge` fields.

### Controller Skeleton

```typescript
@Get('promo-images')
@UseGuards(JwtAuthGuard)
async getPromoImages(@CurrentUser() user: User) {
  // TODO: Query promo images for user.salonId
  // For now, return empty array until dashboard UI is built
  return { images: [] };
}

@Get('bestsellers')
@UseGuards(JwtAuthGuard)
async getBestsellers(
  @CurrentUser() user: User,
  @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
  @Query('days', new DefaultValuePipe(30), ParseIntPipe) days: number,
) {
  const products = await this.printAgentService.getBestsellers(
    user.salonId,
    Math.min(limit, 20),
    days,
  );
  return { products, generatedAt: new Date().toISOString() };
}
```

### Auth

- Use `@UseGuards(JwtAuthGuard)` - same as other print-agent endpoints
- Extract `salonId` from JWT payload via `@CurrentUser()`
- No role restriction needed (any authenticated user from the salon)

### Rate Limiting

- Default rate limit is fine (100/min)
- Print Agent calls every 5 minutes = 0.2 req/min per salon

---

## Display Behavior on Print Agent Side

```
Customer Display Flow:

  POS idle (2 min)  ──>  Promo Carousel  ──>  Bestseller Slides  ──>  Loop
       ^                                                                 |
       |                                                                 |
       └──── POS adds item ──── switches to Cart View ──────────────────┘

Carousel content order:
  1. Promo images (if any) - full-bleed, 5s each
  2. Bestseller product cards - styled cards, 5s each
  3. Loop back to 1
```

---

## Priority

| Endpoint | Priority | Reason |
|----------|----------|--------|
| `GET /bestsellers` | **HIGH** | Uses existing data, no dashboard UI needed |
| `GET /promo-images` | MEDIUM | Needs dashboard UI for uploading images |
| `GET /display-content` | LOW | Optimization, can combine later |

**Recommendation**: Ship `/bestsellers` first. It works immediately from existing order data. Promo images can return `[]` until the dashboard upload UI is built.
