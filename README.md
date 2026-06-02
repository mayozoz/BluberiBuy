# 🧵 BluberiBuy

A personal Chrome extension for tracking price history on luxury fashion items.
Works on **SSENSE** and **The RealReal** out of the box, and is built to be extended.

---

## Features (Phase 1 — this)

- Track any product with one click from the extension popup
- Records full price history with timestamps
- Tracks **high** and **low** watermarks automatically
- Shows a price **sparkline** in the popup
- Background price checks every N hours (no tab required)
- **Browser notifications** on price drops and inventory changes
- Per-item notification settings (on/off)
- Pause tracking without losing history
- SPA-aware — works on React-based sites that don't do full page reloads

## Planned (Phase 2 - still working on this)

- Email notifications via serverless backend (Firebase Functions / Supabase Edge)
- Cross-device sync (Firebase / Supabase storage)
- AI features: price-drop predictions, style recommendations, "buy now or wait" signals
- More supported sites (Farfetch, Net-a-Porter, Vestiaire Collective, etc.)

---

## Project structure

```
Blueberry/
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
4. Select the `BluberiBuy/` folder (the one containing `manifest.json`)
5. The icon will appear in your toolbar (pin it for easy access)

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

All data lives in `chrome.storage.local` under the key `bluberiBuy`.

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
    checkIntervalHours,       // default: 6
    browserNotifications,     // default: true
    emailNotifications,       // default: false
    emailAddress,
    emailJsServiceId,
    emailJsTemplateId,
    emailJsPublicKey,
  }
}
```

To migrate to Firebase or Supabase: replace the internals of `utils/storage.js` with your
SDK calls. The exported function signatures stay exactly the same — nothing else in the
codebase needs to change.

---

## Email notifications

Email alerts are powered by [EmailJS](https://emailjs.com) — no backend required.

1. Create a free EmailJS account and add an email service (Gmail, Outlook, etc.)
2. Create a template using these variables: `{{to_email}}`, `{{subject}}`, `{{item_name}}`, `{{message}}`, `{{item_url}}`
3. In the extension Settings, enter your email address, Service ID, Template ID, and Public Key
4. Enable Email notifications globally, then toggle 📧 on any tracked item

---

## Notes on bot detection

Some luxury sites run Cloudflare or custom bot detection.
The background `fetch()` in the service worker uses realistic request headers and is usually
fine for low-frequency personal use. If a site starts returning 403s, the extension will
gracefully fall back to **passive updates** — it records the price whenever you naturally
visit the product page in a tab (the content script fires automatically).
