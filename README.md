# BluberiBuy

A Chrome extension for tracking price history on luxury fashion items and telling you the perfect time to buy.

Works on **The RealReal**, **Fashionphile**, and **SSENSE**.

**[Install on the Chrome Web Store](https://chromewebstore.google.com/detail/bluberibuy/hebofgjcejgihignpbijmoicklaopijb)** · **[Landing Page](https://mayozoz.github.io/BluberiBuy/)**

---

## Features

- Track any product with one click from the extension popup
- Full price history with sparkline chart, high/low watermarks, and restock markers
- **"Buy now or wait?"** recommendation — combines linear regression with rule-based heuristics (inventory urgency, all-time low, MSRP discount, price stability)
- Background price checks on a configurable schedule (no tab required)
- **Browser and email notifications** for price drops, inventory changes, and target price hits
- Set a **target price** per item and get alerted the moment it's hit
- Organize tracked items into **folders** with drag-and-drop
- Sort by biggest drop %, recently updated, or price
- Consignment-aware — low stock on The RealReal/Fashionphile triggers a stronger buy signal than on a retail site
- SPA-aware — works on React-based sites without full page reloads
- 100% local — no account, no backend, no cloud sync

---

## Project structure

```
BluberiBuy/
├── manifest.json               # MV3 extension config
├── background/
│   └── service-worker.js       # Scheduled background checks, notifications, email
├── content/
│   └── content.js              # Injected into product pages; extracts product data
├── popup/
│   ├── popup.html              # Extension popup UI
│   ├── popup.css               # Cream/brown luxury color scheme
│   └── popup.js                # Popup controller logic
├── utils/
│   ├── storage.js              # Data persistence layer (chrome.storage.local)
│   ├── helpers.js              # Formatting, sparkline chart, inventory display
│   └── heuristic.js            # "Buy now or wait?" scoring algorithm
├── docs/                       # GitHub Pages landing page
├── dev/
│   ├── seed.html               # Dev UI to inject test data
│   └── seed.js                 # Test data generator
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Loading the extension locally

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `BluberiBuy/` folder (the one containing `manifest.json`)

To reload after code changes: click the ↺ icon on the extension card.

---

## Adding a new site

**1. Add a site config block to `content/content.js`**

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

JSON-LD extraction is automatic — check the page source for `<script type="application/ld+json">` with a `Product` node first. Selectors are only a fallback.

**2. Add URL patterns to `manifest.json`**

Add to both `content_scripts[0].matches` and `host_permissions`:

```json
"https://www.newsite.com/products/*"
```

**3. Reload the extension.** That's it.

---

## Email notifications

Email alerts use [EmailJS](https://emailjs.com) — no backend required.

1. Create a free EmailJS account and connect an email service (Gmail, Outlook, etc.)
2. Create a template with these variables: `{{to_email}}`, `{{subject}}`, `{{item_name}}`, `{{message}}`, `{{item_url}}`
3. In the extension Settings, enter your email address, Service ID, Template ID, and Public Key
4. Enable email notifications globally, then toggle the envelope icon on individual items

---

## Data storage schema

All data lives in `chrome.storage.local` under the key `bluberiBuy`.

```js
{
  trackedItems: {
    "<itemId>": {
      id, url, site, siteName, name, brand, image,
      currentPrice, originalPrice, currency,
      highPrice, lowPrice,
      inventory,        // "in_stock" | "low" | "out_of_stock" | "coming_soon" | "sold" | "unknown"
      priceHistory: [{ price, inventory, timestamp, type? }],  // type: "restock" for sentinel entries
      addedAt, lastChecked,
      isActive,         // false = paused
      isHidden,         // true = soft-deleted (history preserved)
      notifications: { browser, email },
      targetPrice,
      folderId
    }
  },
  settings: {
    checkIntervalHours,
    browserNotifications,
    emailNotifications,
    emailAddress,
    emailJsServiceId,
    emailJsTemplateId,
    emailJsPublicKey,
  },
  folders: {
    "<folderId>": { id, name, isDefault, order }
  }
}
```

To migrate to Firebase or Supabase: swap the internals of `utils/storage.js`. The exported function signatures stay the same — nothing else needs to change.

---

## Planned

- Cross-device sync via Firebase or Supabase
- Serverless backend for more reliable email delivery
- Additional supported sites: Farfetch, Net-a-Porter, Vestiaire Collective
- AI-driven price prediction and style recommendations
