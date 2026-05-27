# 🧵 Blueberry

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
```nal use. If a site starts returning 403s, the extension will
gracefully fall back to **passive updates** — it records the price whenever you naturally
visit the product page in a tab (the content script fires automatically).
