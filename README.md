# 🧵 Blueberry

A personal Chrome extension for tracking price history on luxury fashion items.
Works on **SSENSE** and **The RealReal** out of the box, and is built to be extended.

---

## Features (Phase 1 — this scaffold)

- Track any product with one click from the extension popup
- Records full price history with timestamps
- Tracks **high** and **low** watermarks automatically
- Shows a price **sparkline** in the popup
- Background price checks every N hours (no tab required)
- **Browser notifications** on price drops and inventory changes
- Per-item notification settings (on/off)
- Pause tracking without losing history
- SPA-aware — works on React-based sites that don't do full page reloads

## Planned (Phase 2)

- Email notifications via serverless backend (Firebase Functions / Supabase Edge)
- Cross-device sync (Firebase / Supabase storage)
- AI features: price-drop predictions, style recommendations, "buy now or wait" signals
- More supported sites (Farfetch, Net-a-Porter, Vestiaire Collective, etc.)

---

## Project structure

```
price-thread/
├── manifest.json               # Extension config (Manifest V3)
├── popup/
│   ├── popup.html              # Extension popup UI
│   ├── popup.css               # Popup styles
│   └── popup.js                # Popup logic (ES module)
├── background/
│   └── service-worker.js       # Background price checker + notifications
├── content/
│   └── content.js              # Injected into product pages; extracts data
├── utils/
│   ├── storage.js              # All chrome.storage reads/writes (swappable)
│   └── helpers.js              # Price formatting, sparkline, date utils
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

> **Note on icons:** You'll need to add PNG icons at those three sizes before loading the extension. Any 16×16, 48×48, and 128×128 images will work — even plain colored squares for development.

---

## Loading the extension in Chrome

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right)
3. Click **Load unpacked**
4. Select the `price-thread/` folder (the one containing `manifest.json`)
5. The 🧵 icon will appear in your toolbar (pin it for easy access)

To reload after code changes: click the refresh ↺ icon on the extension card in `chrome://extensions`.

---

## How to add a new site

**1. Add the site config to `content/content.js`**

Add a new entry to the `SITE_CONFIGS` object:

```js
'newsite.com': {
  name:        'newsite',
  displayName: 'New Site Name',
  currency:    'USD',
  selectors: {
    price:   ['[data-testid="price"]', '.product-price'],
    name:    ['h1.product-title', 'h1'],
    brand:   ['.brand-name'],
    image:   ['.product-image img'],
    soldOut: ['.sold-out-badge'],
  },
},
```

**Tip:** JSON-LD extraction (the primary method) is automatic — the selectors are only a fallback.
Open the product page, inspect the `<head>`, and look for `<script type="application/ld+json">`.
If there's a `Product` object with `offers.price`, the extension will pick it up with no changes.

**2. Add URL patterns to `manifest.json`**

In both `content_scripts[0].matches` and `host_permissions`:

```json
"https://www.newsite.com/products/*"
```

**3. Reload the extension**

That's it.

---

## Data storage schema

All data lives in `chrome.storage.local` under the key `pricethread`.

```js
{
  trackedItems: {
    "<itemId>": {
      id, url, site, siteName,
      name, brand, image,
      currentPrice, currency,
      highPrice, lowPrice,
      inventory,        // "in_stock" | "low" | "out_of_stock" | "sold" | "unknown"
      priceHistory: [{ price, inventory, timestamp }],
      addedAt, lastChecked,
      isActive,
      notifications: { browser, email }
    }
  },
  settings: {
    checkIntervalHours,     // default: 6
    browserNotifications,   // default: true
    emailNotifications,     // default: false (Phase 2)
    emailAddress,
  }
}
```

To migrate to Firebase or Supabase: replace the internals of `utils/storage.js` with your
SDK calls. The exported function signatures stay exactly the same — nothing else in the
codebase needs to change.

---

## Phase 2: Email notifications (architecture notes)

Email requires a small backend. Recommended approach:

1. **Supabase Edge Function** or **Firebase Cloud Function** — receives a POST request with
   `{ to, subject, body }` and sends via Resend, SendGrid, or Postmark.
2. In `background/service-worker.js`, uncomment the `sendEmailNotification()` stub and point
   it at your function's URL.
3. Store the user's email address in `settings.emailAddress` (already wired to the Settings UI).

---

## Phase 2: AI feature ideas

| Feature | Approach |
|---|---|
| "Buy now or wait?" signal | Fine-tuned time-series model on price history |
| Style recommendations | Embeddings on product name/brand + collaborative filtering |
| Price anomaly detection | Simple z-score or IQR on rolling window |
| Natural-language search | Semantic search over tracked items via embeddings |
| Trend alerts | Detect if a brand is in a markdown cycle |

All of these can be implemented as serverless functions the extension calls, keeping the
extension itself lightweight.

---

## Notes on bot detection

Some luxury sites (especially on the SSense side) run Cloudflare or custom bot detection.
The background `fetch()` in the service worker uses realistic request headers and is usually
fine for low-frequency personal use. If a site starts returning 403s, the extension will
gracefully fall back to **passive updates** — it records the price whenever you naturally
visit the product page in a tab (the content script fires automatically).
