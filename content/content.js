/**
 * content.js — BluberiBuy content script
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
    productPath: /\/product\//,  // pages this matches are product pages; anything else is ignored
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
    resale:      true,
    productPath: /^\/products\//,  // pages this matches are product pages; anything else is ignored
    currency:    'USD',
    selectors: {
      price:   ['[data-testid="price"]', '[class*="product-price"]', '[class*="ProductPrice"]', '[class*="Price"]'],
      name:    ['[data-testid="product-name"]', 'h1[class*="title"]', 'h1[class*="name"]', 'h1'],
      brand:   ['[data-testid="brand-name"]', '[class*="brand-name"]', '[class*="BrandName"]'],
      image:   ['[data-testid="product-image"] img', '[class*="product-image"] img', '[class*="ProductImage"] img'],
      soldOut: ['[data-testid="sold-badge"]', '[class*="sold"]', '[class*="Sold"]'],
    },
  },

  // The Outnet: NET-A-PORTER's luxury outlet. Limited stock, items don't restock.
  // No JSON-LD — relies entirely on CSS selectors.
  // Class names use CSS modules with a build hash (e.g. PriceWithSchema11__value)
  // so selectors use [class*=] substring matching to stay hash-independent.
  'theoutnet.com': {
    name:        'theoutnet',
    displayName: 'The Outnet',
    productPath: /\/(shop\/product|products)\//,  // pages this matches are product pages; anything else is ignored
    currency:    'USD',
    selectors: {
      price:   ['[class*="__value"] span[content]', '[class*="__value"]'],
      name:    ['h1 [class*="__name"]', 'h1'],
      brand:   ['h1 [class*="__designer"] a', '[class*="__designer"] a'],
      image:   ['[class*="__image"] img', '[class*="__mediaImage"] img'],
      soldOut: ['[class*="__soldOut"]', '[class*="sold-out"]', 'button[disabled][class*="bag"]'],
    },
  },

  // Fashionphile: Shopify-based luxury resale.
  // JSON-LD extraction (Strategy A) handles price/brand/image automatically.
  // Selectors below are the CSS fallback only.
  'fashionphile.com': {
    name:        'fashionphile',
    displayName: 'Fashionphile',
    resale:      true,
    productPath: /^\/products\//,  // pages this matches are product pages; anything else is ignored
    currency:    'USD',
    selectors: {
      price:   ['.price-item--sale', '.price-item--regular', '.price-item'],
      name:    ['.fp-product-title__details', 'h1.product__title', 'h1'],
      brand:   ['.fp-product-vendor__link', '.fp-product-vendor', '[class*="vendor"]'],
      image:   ['.product__media img', '.product-media img', '[class*="ProductMedia"] img'],
      soldOut:     ['[data-sold-out-message]', '.sold-out-message', 'button[disabled][name="add"]'],
      comingSoon:  ['[class*="coming-soon"]', '[class*="comingSoon"]', '[data-coming-soon]', '[class*="notify-me"]', '.notify-me-form'],
    },
  },

  // Vestiaire Collective: peer-to-peer luxury resale, one-of-a-kind items.
  // Next.js site — the product lives in the __NEXT_DATA__ JSON (see
  // extractVestiaire), which also says whether it has sold. Regional
  // subdomains (us., uk., fr., …) price in their own currency.
  'vestiairecollective.com': {
    name:        'vestiairecollective',
    displayName: 'Vestiaire Collective',
    resale:      true,
    productPath: /\.shtml$/,  // pages this matches are product pages; anything else is ignored
    currency:    'USD',
    extract:     () => extractVestiaire(),
    selectors: {
      price:   ['[data-cy="product_price"]', '[class*="productPrice"]', '[class*="price"]'],
      name:    ['[data-cy="product_title"]', 'h1'],
      brand:   ['[data-cy="product_brand"]', '[class*="brand"] a', '[class*="brand"]'],
      image:   ['[class*="productImage"] img', '[class*="gallery"] img', 'main img'],
      soldOut: ['[data-cy*="sold"]', '[class*="sold"]', '[class*="Sold"]'],
    },
  },

};

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Stable numeric hash of a URL (strips query params, trailing slash, and a
 * leading "www." so www/bare-domain redirects map to the same item).
 * Keep in sync with itemIdForUrl() in utils/storage.js.
 */
function generateItemId(url) {
  const canonical = url.split('?')[0].split('#')[0].replace(/\/$/, '').replace('://www.', '://');
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
  '[class*="__previousPrice"]',  // The Outnet CSS module pattern
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
function extractFromJsonLd(config) {
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  const pagePath = window.location.pathname.replace(/\/$/, '');
  let fallback   = null;
  let soldNode   = null;   // Product listed with no offer — typical of a sold item

  for (const script of scripts) {
    let parsed;
    try { parsed = JSON.parse(script.textContent); } catch { continue; }

    const candidates = (Array.isArray(parsed) ? parsed : [parsed])
      .flatMap(node => node?.['@graph'] ?? [node]);

    for (const node of candidates) {
      const type = node?.['@type'];
      if (type !== 'Product' && !(Array.isArray(type) && type.includes('Product'))) continue;

      const offers = flattenOffers(node.offers);
      const buyable = offers.find(o => /instock|limitedavail/i.test(o.availability || ''));
      const offer   = buyable || offers[0];
      const price   = toPrice(offer?.price ?? offer?.lowPrice);
      if (!price) {
        if (!soldNode) soldNode = node;
        continue;
      }

      // Stock across all offers (one per size on multi-size listings)
      const avails = offers.map(o => String(o.availability || '').toLowerCase());
      let inventory = 'unknown';
      if      (avails.some(a => a.includes('instock')))                          inventory = 'in_stock';
      else if (avails.some(a => a.includes('limitedavail')))                     inventory = 'low';
      else if (avails.some(a => a.includes('preorder') || a.includes('presale'))) inventory = 'coming_soon';
      else if (avails.some(a => a.includes('discontinued')))                     inventory = 'sold';
      else if (avails.some(a => a.includes('outofstock') || a.includes('soldout'))) inventory = 'out_of_stock';

      // Look for the original / list price in priceSpecification
      let originalPrice = null;
      if (offer?.priceSpecification) {
        const specs = Array.isArray(offer.priceSpecification)
          ? offer.priceSpecification
          : [offer.priceSpecification];
        const listSpec = specs.find(s =>
          /ListPrice|SuggestedRetailPrice|RegularPrice/i.test(s.priceType || '')
        );
        if (listSpec) originalPrice = toPrice(listSpec.price);
      }
      // Fallback: offers.highPrice (non-standard but used by some retailers)
      if (!originalPrice && offer?.highPrice) {
        const hp = toPrice(offer.highPrice);
        if (hp > price) originalPrice = hp;
      }

      const result = {
        name:          node.name || '',
        brand:         node.brand?.name || '',
        price,
        originalPrice: originalPrice || null,
        currency:      offer?.priceCurrency || 'USD',
        image:         (Array.isArray(node.image) ? node.image[0] : node.image) || '',
        inventory,
      };

      // Prefer the node whose URL matches this page — avoids picking up
      // JSON-LD injected for recommended/related products on the same page.
      const nodeUrl = (node.url || node['@id'] || offer?.url || '').replace(/\/$/, '');
      if (nodeUrl && nodeUrl.includes(pagePath)) return result;

      if (!fallback) fallback = result;
    }
  }
  if (fallback) return fallback;

  // The page describes a product but with no price in its offer — Fashionphile
  // does this once an item sells. Its last price is still in the Open Graph
  // tags. The page's visible prices belong to *recommended* items, so never
  // fall back to CSS selectors here (that's how sold items used to pick up a
  // stranger's $120 price).
  if (soldNode) {
    const meta = document.querySelector(
      'meta[property="og:price:amount"], meta[property="product:price:amount"]'
    );
    const price = toPrice(meta?.content);
    if (!price) return { unreadable: true };
    return {
      name:          soldNode.name || '',
      brand:         soldNode.brand?.name || '',
      price,
      originalPrice: null,
      currency:      document.querySelector('meta[property="og:price:currency"]')?.content || 'USD',
      image:         (Array.isArray(soldNode.image) ? soldNode.image[0] : soldNode.image) || '',
      inventory:     config.resale ? 'sold' : 'out_of_stock',
    };
  }
  return null;
}

// offers may be a single Offer, an array, or an AggregateOffer wrapping more offers
function flattenOffers(offers) {
  if (!offers) return [];
  return (Array.isArray(offers) ? offers : [offers]).flatMap(o =>
    o?.offers ? [o, ...flattenOffers(o.offers)] : [o]
  ).filter(Boolean);
}

// "4,045.00" → 4045; null for missing / unparseable / non-positive values
function toPrice(value) {
  if (value == null) return null;
  const n = parseFloat(String(value).replace(/,/g, ''));
  return isNaN(n) || n <= 0 ? null : n;
}

/**
 * Vestiaire Collective: read the product from Next.js's __NEXT_DATA__ JSON.
 * Expected at props.pageProps.product; if the site reshuffles its props we
 * search for any object shaped like a product (name + price.cents).
 */
function extractVestiaire() {
  const script = document.getElementById('__NEXT_DATA__');
  if (!script) return null;

  let data;
  try { data = JSON.parse(script.textContent); } catch { return null; }

  const product = data?.props?.pageProps?.product || findVestiaireProduct(data);
  if (!product) return null;

  const cents = Number(product.price?.cents);
  if (!cents) return null;

  let inventory = 'in_stock';
  if (product.sold)                                         inventory = 'sold';
  else if (product.reserved)                                inventory = 'low';
  else if (product.inStock === false || product.available === false) inventory = 'out_of_stock';

  const ogImage = document.querySelector('meta[property="og:image"]')?.content;
  const picture = product.pictures?.[0]?.path;

  return {
    name:          product.name || document.title,
    brand:         product.brand?.name || '',
    price:         cents / 100,
    originalPrice: null,
    currency:      product.price?.currency || 'USD',
    image:         ogImage || (picture?.startsWith('http') ? picture : ''),
    inventory,
  };
}

function findVestiaireProduct(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  if (node.name && node.price?.cents != null) return node;
  for (const value of Object.values(node)) {
    const found = findVestiaireProduct(value, depth + 1);
    if (found) return found;
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
  const comingSoonEl    = config.selectors.comingSoon ? queryFirst(config.selectors.comingSoon) : null;
  const originalPriceEl = queryFirst(ORIGINAL_PRICE_SELECTORS);

  const price         = parsePrice(priceEl?.textContent?.trim());
  const parsedOriginal = parsePrice(originalPriceEl?.textContent?.trim());
  // Only use original price if it's strictly higher than the sale price
  const originalPrice = parsedOriginal && parsedOriginal > price ? parsedOriginal : null;

  let inventory = 'in_stock';
  if (comingSoonEl)  inventory = 'coming_soon';
  else if (soldOutEl) inventory = 'out_of_stock';

  return {
    name:          nameEl?.textContent?.trim() || document.title,
    brand:         brandEl?.textContent?.trim() || '',
    price,
    originalPrice,
    currency:      config.currency || 'USD',
    image:         imageEl?.src || imageEl?.getAttribute('data-src') || '',
    inventory,
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

/**
 * True only on a product page. SPAs (SSENSE) keep this script alive while the
 * user browses listing pages; reading one of those would track the listing
 * URL as if it were whichever product rendered first.
 */
function isProductPage(config = getCurrentSiteConfig()) {
  return !!config && (!config.productPath || config.productPath.test(window.location.pathname));
}

function extractProductData() {
  const config = getCurrentSiteConfig();
  if (!config || !isProductPage(config)) return null;

  // Site-specific extractor (if any), then JSON-LD, then DOM selectors
  const product = config.extract?.() || extractFromJsonLd(config) || extractFromSelectors(config);

  if (!product || product.unreadable || !product.price) return null;

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

  if (!isProductPage()) {
    sendResponse({ success: false, error: 'This isn\'t a product page. Open a single item to track it.' });
    return false;
  }

  // Retry up to 5 times at 700ms intervals to handle SPAs (React, etc.) that
  // render product content after document_idle fires.
  const attempt = (retriesLeft) => {
    try {
      const data = extractProductData();
      if (data) {
        sendResponse({ success: true, data });
      } else if (retriesLeft > 0) {
        setTimeout(() => attempt(retriesLeft - 1), 700);
      } else {
        sendResponse({ success: false, error: 'Could not extract product data from this page.' });
      }
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
  };

  attempt(5);
  return true; // Keep the message channel open for async sendResponse
});

// ─── Report the live price to the background worker ───────────────────────────
// Every visit to a product page is a free price check: the worker records it
// (if the item is tracked) and sends any drop / target / stock alerts.

function reportPrice(retriesLeft = 5) {
  const data = extractProductData();
  if (data) {
    chrome.runtime.sendMessage({ type: 'PAGE_PRICE_UPDATE', data }).catch(() => {});
  } else if (retriesLeft > 0) {
    // SPAs may render the product after document_idle
    setTimeout(() => reportPrice(retriesLeft - 1), 700);
  }
}

reportPrice();

// Some sites (SSENSE) are SPAs — the URL changes without a full page reload,
// so report again whenever it does.

let lastUrl = window.location.href;

const observer = new MutationObserver(() => {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    // Small delay to let the new page's DOM render
    setTimeout(() => reportPrice(), 1500);
  }
});

observer.observe(document.body, { childList: true, subtree: true });
