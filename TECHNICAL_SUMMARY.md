# BluberiBuy — Technical Summary

**Version:** 0.1.0  
**Type:** Chrome Extension (Manifest V3)  
**Stack:** Vanilla JavaScript, Chrome Extension APIs, EmailJS

---

## What It Does

BluberiBuy is a Chrome extension for tracking price history on luxury resale and retail fashion items. It lets users monitor products across SSENSE, The RealReal, and Fashionphile, receive alerts when prices drop or inventory changes, and get an algorithmic "buy now or wait?" recommendation based on historical price trends.

---

## Directory Structure

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
│   └── popup.js                # All popup controller logic
├── utils/
│   ├── storage.js              # Data persistence layer (chrome.storage.local)
│   ├── helpers.js              # Formatting, sparkline chart, inventory display
│   └── heuristic.js            # "Buy now or wait?" scoring algorithm
├── dev/
│   ├── seed.html               # Dev UI to inject test data
│   └── seed.js                 # Test data generator
└── icons/                      # 16px, 48px, 128px extension icons
```

No npm dependencies. Entirely vanilla JS + browser APIs.

---

## Architecture Overview

The extension has three distinct execution contexts that communicate via Chrome message passing:

```
[Product Page]                  [Popup]                     [Background]
content.js          <──────>    popup.js         <──────>   service-worker.js
  │ Extracts price              │ Dashboard UI               │ Periodic alarms
  │ Watches DOM                 │ Folder management          │ Fetches prices
  │ Detects inventory           │ Settings                   │ Sends notifications
  └──── PAGE_PRICE_UPDATE ──────┤                            │
                                └──── REFRESH_ITEM ──────────┘
                                     GET_PRODUCT_DATA ─────> content.js
```

All persistent data lives in `chrome.storage.local`, managed through `utils/storage.js`.

---

## Component Details

### 1. Content Script (`content/content.js`)

Injected at `document_idle` on matching product pages. Responsible for extracting structured product data from the page.

**Extraction strategy (in priority order):**

1. **JSON-LD parsing** — reads `<script type="application/ld+json">` blocks for `@type: "Product"` nodes. This is the primary method since most e-commerce sites embed structured data. Extracts price, currency, availability, and original price from `priceSpecification`.
2. **CSS selector fallback** — site-specific selectors for price, name, brand, image, sold-out state. Used when JSON-LD is absent or incomplete.

**Extracted product object:**
```javascript
{
  id: string,           // hash of canonical URL
  url: string,
  site: string,         // "ssense" | "therealreal" | "fashionphile"
  siteName: string,
  name: string,
  brand: string,
  image: string,
  price: number,
  originalPrice: number | null,
  currency: string,
  inventory: "in_stock" | "low" | "out_of_stock" | "coming_soon" | "sold" | "unknown"
}
```

**SPA support:** Observes DOM mutations and listens for URL changes. When the URL changes (e.g., SSENSE's React router navigation), it re-extracts and sends a `PAGE_PRICE_UPDATE` message to the service worker.

---

### 2. Service Worker (`background/service-worker.js`)

Runs in the background with no active tab. Handles scheduled price checks and all outbound notifications.

**Alarm system:**
- Creates a recurring `chrome.alarms` entry on install/startup (default: every 6 hours)
- Interval is adjustable via `UPDATE_CHECK_INTERVAL` message from the popup
- On alarm fire: iterates all active tracked items, fetches each URL, checks for threshold breaches

**Price fetch & parse:**
- Uses `fetch()` with realistic browser headers (to reduce bot-detection rejections)
- Parses JSON-LD from raw HTML via regex (no DOM parser available in service workers)
- Compares fetched price to stored price

**Notification triggers:**
| Condition | Threshold | Actions |
|---|---|---|
| Price drop | ≥ 5% decrease | Browser notification + optional email |
| Inventory change | → out_of_stock or → low | Browser notification + optional email |
| Target price reached | current ≤ user-set target | Browser notification + optional email |

**Message handlers:**
- `REFRESH_ITEM` — manual single-item refresh triggered from popup
- `PAGE_PRICE_UPDATE` — passive price observation from content script

**Email notifications (EmailJS):**
- Calls EmailJS API directly from the service worker (no backend required)
- User supplies Service ID, Template ID, and Public Key in settings
- Template variables: `{{to_email}}`, `{{subject}}`, `{{item_name}}`, `{{message}}`, `{{item_url}}`
- Each item has its own email/browser notification toggles

---

### 3. Popup UI (`popup/popup.js`, `popup.html`, `popup.css`)

The main user interface, opened by clicking the extension icon. Structured as two tabs plus a settings overlay.

**Tab 1 — This Item**

Shown when the active tab is a supported product page. Displays:
- Product card: image, brand, name, site
- Current price, original/MSRP price, discount badge
- **Track / Untrack** button (primary action)

When an item is tracked, also shows:
- Price watermarks: all-time high, all-time low, check count
- **Sparkline chart** (canvas-based price history visualization)
- **Verdict badge**: "Buy now" / "Wait" / "Hold steady" with confidence dots (●●●, ●●○, ●○○)
- Notification settings: per-item browser/email toggles, target price input
- Manual refresh button

**Tab 2 — Tracked Items**

Grid view of all tracked items, organized into folders.

- **Folders:** Collapsible sections, default folders per site + user-created custom folders
  - Rename / delete folders (custom only, with confirmation)
  - Drag-and-drop items between folders
- **Sort options:** Recently added, Biggest drop %, Recently updated, Price (low → high)
- **Filter:** In-stock only toggle
- **Summary bar:** Total item count + total savings vs MSRP
- **Item cards:**
  - Top-left dot: inventory status (green/yellow/red/gray)
  - Top-right ×: remove button
  - Hover: shows brand, name, current price, delta from first tracked price

**Settings overlay**

- Check interval selector (1h, 3h, 6h, 12h, 24h)
- Global browser notifications toggle
- Email notifications toggle + email address
- EmailJS credentials (Service ID, Template ID, Public Key)

---

### 4. Storage Layer (`utils/storage.js`)

All data is stored under a single `chrome.storage.local` key (`bluberiBuy`) and managed through this module. The abstraction is intentionally designed to be swappable for Firebase or Supabase later.

**Top-level data shape:**
```javascript
{
  trackedItems: {
    [itemId]: {
      // Identity
      id, url, site, siteName, name, brand, image,
      // Pricing
      currentPrice, originalPrice, currency,
      highPrice, lowPrice,
      // Inventory
      inventory,
      // History
      priceHistory: [{ price, inventory, timestamp }],
      // Lifecycle
      addedAt, lastChecked,
      isActive,     // false = paused (skipped in background checks)
      isHidden,     // true = soft-deleted (data preserved)
      // Alerts
      notifications: { browser: bool, email: bool },
      targetPrice,
      // Organization
      folderId
    }
  },
  settings: {
    checkIntervalHours,
    browserNotifications, emailNotifications,
    emailAddress, emailJsServiceId, emailJsTemplateId, emailJsPublicKey
  },
  folders: {
    [folderId]: { id, name, isDefault, order }
  }
}
```

**Soft-delete & history restoration:**
- `removeItem()` sets `isHidden: true` — data and full price history are kept
- Re-tracking the same URL flips `isHidden` back to `false` and restores all history

**Restock detection:**
- When a price observation follows an `out_of_stock` or `sold` state with a current `in_stock` or `low` state, a sentinel entry `{ type: 'restock', ... }` is inserted into `priceHistory`
- This enables episode-aware analysis and visual markers in the sparkline

---

### 5. Heuristic Engine (`utils/heuristic.js`)

Produces the "Buy now / Wait / Hold steady" verdict shown in the popup.

**Inputs:** Full price history, MSRP, current inventory, site type  
**Output:** `{ verdict: 'buy'|'wait'|'hold', reason: string, confidence: 'low'|'medium'|'high' }`

#### Step 1 — Episode Isolation

Before any analysis, the algorithm finds the **most recent restock marker** in the price history and discards everything before it. This means a price from a previous availability cycle doesn't distort the current trend.

```
allHistory: [p1, p2, restock, p3, p4, p5]
                          ↑
                    episodeStart = here
working = [p3, p4, p5]
```

If the current episode has fewer than 3 data points, it falls back to full history to avoid a data-sparse analysis.

#### Step 2 — Linear Regression (Option A)

A least-squares regression line is fit through the episode's price history:

1. Timestamps are **normalized to [0, 1]** so the slope is scale-independent across time ranges
2. Standard formula: `slope = (n·ΣXY − ΣX·ΣY) / (n·ΣX² − (ΣX)²)`
3. Slope is converted to **% of current price** (`slopePct`)

| `slopePct` | Meaning | Score |
|---|---|---|
| `< -3%` | Trending down — price still falling | `+2` (lean buy) |
| `> +3%` | Trending up — price rising | `-2` (lean wait) |
| Between | Flat — neutral | `0` |

#### Step 3 — Rule-Based Heuristics (Option B)

Five rules each add or subtract from the same score accumulator:

**Rule 1 — At All-Time Low** (`+3`)  
`currentPrice <= item.lowPrice * 1.02` (within 2% tolerance)  
Strongest non-inventory buy signal. If you're at the floor, it's unlikely to go lower.

**Rule 2 — Multiple Recent Drops** (`-2`)  
3+ price drops in the last 30 days within the current episode.  
A price still actively falling is worth waiting out.

**Rule 3 — Price Stability Floor** (`+1`)  
Price unchanged for 14+ days.  
Suggests the price has settled; waiting longer offers little upside.

**Rule 4 — Deep MSRP Discount** (`+2`)  
40%+ off the original/MSRP price.  
Deep discounts rarely deepen further; diminishing returns on waiting.

**Rule 5 — Inventory Urgency** (site-aware, `+2` or `+4`)  
This rule distinguishes site types:
- **Consignment sites** (The RealReal, Fashionphile): items are unique. Low stock means that exact piece is nearly gone and will not be restocked.
- **Retail sites** (SSENSE): items can be restocked, so low stock is less urgent.

| Inventory | Site | Score |
|---|---|---|
| `low` | Consignment | `+4` |
| `low` | Retail | `+2` |
| Just flipped `in_stock → low` | Retail | `+4` (urgency bump) |

#### Step 4 — Final Score → Verdict

All signals accumulate into a single integer:

```
score ≥ 4   →  BUY   (confidence: high if ≥ 7, medium otherwise)
score ≤ -2  →  WAIT  (confidence: high if ≤ -4, medium otherwise)
-2 < score < 4  →  HOLD  (confidence: low)
```

Maximum possible score: `+12` (all buy signals fire). Minimum: `-4` (regression + frequent drops).

#### Step 5 — Human-Readable Reason

The top two `why` strings are joined into a single sentence shown in the popup:

```
"At its lowest tracked price & low stock on a consignment item."
```

**Confidence** maps to the dot indicators in the popup: ●●● = high, ●●○ = medium, ●○○ = low.

---

### 6. Sparkline Chart (`utils/helpers.js`)

Canvas-based price history chart rendered inside the popup.

- **Price area:** Gradient fill (violet normally; green if item is ≥ 30% off MSRP)
- **MSRP reference line:** Dashed horizontal line with "MSRP" label
- **All-time low marker:** Green dot with price label
- **Current price marker:** Violet dot at rightmost point
- **Restock breaks:** Dotted vertical lines with a ↺ icon where restocks occurred
- Handles edge cases: < 2 data points shows "Not enough data yet" message

---

## Supported Sites

| Site | URL Pattern | Notes |
|---|---|---|
| SSENSE | `ssense.com/*` | Retail; React SPA |
| The RealReal | `therealreal.com/*` | Consignment |
| Fashionphile | `fashionphile.com/*` | Consignment/resale; Shopify-based; has "coming soon" state |

Adding a new site requires: (1) a site config block in `content.js`, and (2) new URL patterns in `manifest.json`. JSON-LD extraction works automatically for any site that embeds it.

---

## Data Flow Summary

```
User visits product page
  → content.js extracts product data
  → User clicks "Track" in popup
    → popup.js calls storage.addItem()
    → Item saved to chrome.storage.local

Background alarm fires every N hours
  → service-worker.js fetches item URL
  → Parses new price from JSON-LD
  → storage.recordPrice() updates history + watermarks
  → If threshold breached:
      → chrome.notifications (if enabled)
      → EmailJS API call (if enabled)

User opens popup on tracked page
  → popup.js calls GET_PRODUCT_DATA → content.js
  → Renders current price, sparkline, verdict
  → User can adjust target price, notification settings, folder
```

---

## Privacy & Security

- **No cloud sync** (Phase 1): All data stays in `chrome.storage.local` on the user's machine
- **No backend**: Email alerts use EmailJS directly from the browser; no server receives user data
- **Credentials stored locally**: EmailJS keys live in `chrome.storage.local`
- **Fetch headers**: Service worker uses browser-like headers when fetching prices; no tracking parameters added

---

## Notable Design Decisions

| Decision | Rationale |
|---|---|
| JSON-LD first for extraction | Structured data is more stable than CSS selectors; also works in service worker where there's no DOM |
| Soft-delete with restore | Preserves full price history if a user removes and re-adds an item |
| Restock sentinels in history | Lets the heuristic and chart treat each availability cycle as a separate episode |
| Storage abstraction layer | Isolates chrome.storage so the backend can be swapped to Firebase/Supabase without touching business logic |
| No npm dependencies | Keeps the extension self-contained, auditable, and fast-loading |
| Per-item notification toggles | High-value items may warrant email alerts; lower-priority items browser-only |
| Consignment vs retail awareness | TRR/Fashionphile items have finite stock; heuristic weighs low inventory more heavily than for SSENSE |

---

## Planned Phase 2 Features

- Cross-device sync via Firebase or Supabase
- Serverless backend for more reliable email delivery
- Additional supported sites: Farfetch, Net-a-Porter, Vestiaire Collective
- AI-driven price prediction and style recommendations
- More granular "buy now or wait" signals

---

## Quick Stats

| File | Purpose |
|---|---|
| `manifest.json` | MV3 config, permissions, URL matching |
| `background/service-worker.js` | ~8 KB — background checks, notifications, email |
| `content/content.js` | ~9 KB — page extraction, SPA monitoring |
| `popup/popup.js` | ~24 KB — UI controller, folders, drag-drop |
| `popup/popup.css` | ~28 KB — all styling |
| `utils/storage.js` | ~12 KB — data layer |
| `utils/helpers.js` | ~11 KB — sparkline, formatting |
| `utils/heuristic.js` | ~7 KB — scoring algorithm |
| **Total source** | **~116 KB** (no build step needed) |
