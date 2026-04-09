/**
 * content.js — PriceThread content script
 *
 * Injected into supported product pages. Responsible for:
 *   1. Detecting which site we're on
 *   2. Extracting structured product data (price, name, brand, inventory)
 *   3. Responding to messages from the popup and service worker
 *
 * Extraction strategy (tried in order):
 *   a) JSON-LD  — <script type="application/ld+json"> Product schema
 *      (most e-commerce sites embed this; it's the most reliable source)
 *   b) Site-specific CSS selectors (fallback)
 *
 * HOW TO ADD A NEW SITE
 * ─────────────────────
 * 1. Add a new entry to SITE_CONFIGS below.
 * 2. Add the URL pattern to manifest.json → content_scripts.matches
 *    and host_permissions.
 * That's it.
 */

// ─── Site configurations ───────────────────────────────────────────────────────

const SITE_CONFIGS = {

  'ssense.com': {
    name:        'ssense',
    displayName: 'SSENSE',
    currency:    'USD',
    selectors: {
      price:   ['[data-testid="price"]', '.pdp__price', '[class*="finalPrice"]', '[class*="price-final"]', 'span[class*="Price"]'],
      name:    ['h1[class*="title"]', 'h1[class*="name"]', '.pdp__name', 'h1'],
      brand:   ['[class*="brand-name"]', '[class*="brandName"]', '.pdp__brand', 'a[class*="brand"]'],
      image:   ['.pdp__media img', '[class*="ProductImage"] img', '[class*="hero"] img', 'img[class*="product"]'],
      soldOut: ['[class*="sold-out"]', 'button[disabled][class*="bag"]', '[class*="unavailable"]'],
    },
  },

  'therealreal.com': {
    name:        'therealreal',
    displayName: 'The RealReal',
    currency:    'USD',
    selectors: {
      price:   ['[data-testid="price"]', '[class*="product-price"]', '[class*="ProductPrice"]', '[class*="Price"]'],
      name:    ['[data-testid="product-name"]', 'h1[class*="title"]', 'h1[class*="name"]', 'h1'],
      brand:   ['[data-testid="brand-name"]', '[class*="brand-name"]', '[class*="BrandName"]'],
      image:   ['[data-testid="product-image"] img', '[class*="product-image"] img', '[class*="ProductImage"] img'],
      soldOut: ['[data-testid="sold-badge"]', '[class*="sold"]', '[class*="Sold"]'],
    },
  },

};

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Stable numeric hash of a URL (strips query params and trailing slash). */
function generateItemId(url) {
  const canonical = url.split('?')[0].split('#')[0].replace(/\/$/, '');
  let hash = 0;
  for (let i = 0; i < canonical.length; i++) {
    hash = Math.imul(31, hash) + canonical.charCodeAt(i) | 0;
  }
  return Math.abs(hash).toString(36);
}

/** Return the first matching element for a list of CSS selectors. */
function queryFirst(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

/** Parse a price string like "$1,295.00" or "CAD 890" → float */
function parsePrice(text) {
  if (!text) return null;
  const match = text.match(/[\d,]+(\.\d{1,2})?/);
  if (!match) return null;
  const value = parseFloat(match[0].replace(/,/g, ''));
  return isNaN(value) ? null : value;
}

// ─── Original price selectors (crossed-out / MSRP) ────────────────────────────
// These target the struck-through original price shown next to a sale price.
// Ordered from most specific to most generic to avoid false matches.

const ORIGINAL_PRICE_SELECTORS = [
  '[class*="original-price"]', '[class*="originalPrice"]',
  '[class*="was-price"]',      '[class*="wasPrice"]',
  '[class*="compare-price"]',  '[class*="comparePrice"]',
  '[class*="retail-price"]',   '[class*="retailPrice"]',
  '[class*="regular-price"]',  '[class*="regularPrice"]',
  '[class*="list-price"]',     '[class*="listPrice"]',
  'del', 's',   // HTML semantic strikethrough — broad but works on many sites
];

// ─── Extraction strategies ─────────────────────────────────────────────────────

/**
 * Strategy A: JSON-LD  <script type="application/ld+json">
 * Returns a partial product object or null.
 *
 * originalPrice is sourced from (in order of preference):
 *   1. offers.priceSpecification[] with priceType = ListPrice / SRP
 *   2. offers.highPrice (some retailers put MSRP here)
 */
function extractFromJsonLd() {
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    let parsed;
    try { parsed = JSON.parse(script.textContent); } catch { continue; }

    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    for (const node of candidates) {
      if (node['@type'] !== 'Product') continue;

      const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
      const price = offer ? parseFloat(offer.price) : null;
      if (!price) continue;

      const availability = (offer?.availability || '').toLowerCase();
      let inventory = 'unknown';
      if (availability.includes('outofstock'))        inventory = 'out_of_stock';
      else if (availability.includes('limitedavail')) inventory = 'low';
      else if (availability.includes('instock'))      inventory = 'in_stock';

      // Look for the original / list price in priceSpecification
      let originalPrice = null;
      if (offer?.priceSpecification) {
        const specs = Array.isArray(offer.priceSpecification)
          ? offer.priceSpecification
          : [offer.priceSpecification];
        const listSpec = specs.find(s =>
          /ListPrice|SuggestedRetailPrice|RegularPrice/i.test(s.priceType || '')
        );
        if (listSpec) originalPrice = parseFloat(listSpec.price) || null;
      }
      // Fallback: offers.highPrice (non-standard but used by some retailers)
      if (!originalPrice && offer?.highPrice) {
        const hp = parseFloat(offer.highPrice);
        if (hp > price) originalPrice = hp;
      }

      return {
        name:          node.name || '',
        brand:         node.brand?.name || '',
        price,
        originalPrice: originalPrice || null,
        currency:      offer?.priceCurrency || 'USD',
        image:         (Array.isArray(node.image) ? node.image[0] : node.image) || '',
        inventory,
      };
    }
  }
  return null;
}

/**
 * Strategy B: CSS selector fallback using site-specific config.
 */
function extractFromSelectors(config) {
  const priceEl         = queryFirst(config.selectors.price);
  const nameEl          = queryFirst(config.selectors.name);
  const brandEl         = queryFirst(config.selectors.brand);
  const imageEl         = queryFirst(config.selectors.image);
  const soldOutEl       = queryFirst(config.selectors.soldOut);
  const originalPriceEl = queryFirst(ORIGINAL_PRICE_SELECTORS);

  const price         = parsePrice(priceEl?.textContent?.trim());
  const parsedOriginal = parsePrice(originalPriceEl?.textContent?.trim());
  // Only use original price if it's strictly higher than the sale price
  const originalPrice = parsedOriginal && parsedOriginal > price ? parsedOriginal : null;

  return {
    name:          nameEl?.textContent?.trim() || document.title,
    brand:         brandEl?.textContent?.trim() || '',
    price,
    originalPrice,
    currency:      config.currency || 'USD',
    image:         imageEl?.src || imageEl?.getAttribute('data-src') || '',
    inventory:     soldOutEl ? 'out_of_stock' : 'in_stock',
  };
}

// ─── Main extraction ───────────────────────────────────────────────────────────

function getCurrentSiteConfig() {
  const hostname = window.location.hostname;
  for (const [domain, config] of Object.entries(SITE_CONFIGS)) {
    if (hostname.includes(domain)) return config;
  }
  return null;
}

function extractProductData() {
  const config = getCurrentSiteConfig();
  if (!config) return null;

  // Try JSON-LD first; fall back to DOM selectors
  const fromLd  = extractFromJsonLd();
  const product  = fromLd || extractFromSelectors(config);

  if (!product || !product.price) return null;

  return {
    ...product,
    id:       generateItemId(window.location.href),
    url:      window.location.href,
    site:     config.name,
    siteName: config.displayName,
  };
}

// ─── Message listener ──────────────────────────────────────────────────────────

/**
 * The popup sends a GET_PRODUCT_DATA message and waits for the response.
 * The service worker may also request a refresh via the same message type.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'GET_PRODUCT_DATA') return false;

  try {
    const data = extractProductData();
    if (data) {
      sendResponse({ success: true, data });
    } else {
      sendResponse({ success: false, error: 'Could not extract product data from this page.' });
    }
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }

  return true; // Keep the message channel open for async sendResponse
});

// ─── Auto-update on navigation (SPAs) ─────────────────────────────────────────
// Some sites (SSENSE) are SPAs — the URL changes without a full page reload.
// We notify the background worker whenever the URL changes so it can update the price.

let lastUrl = window.location.href;

const observer = new MutationObserver(() => {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    // Small delay to let the new page's DOM render
    setTimeout(() => {
      const data = extractProductData();
      if (data) {
        chrome.runtime.sendMessage({ type: 'PAGE_PRICE_UPDATE', data });
      }
    }, 1500);
  }
});

observer.observe(document.body, { childList: true, subtree: true });
