/**
 * service-worker.js — PriceThread background service worker (MV3)
 *
 * Responsibilities:
 *   1. Set up a recurring alarm to background-check all tracked item prices
 *   2. Fetch product pages and parse prices from JSON-LD (no active tab needed)
 *   3. Fire browser notifications on price drops or inventory changes
 *   4. Passively receive live price updates pushed by content.js on page visits
 *
 * Why fetch from the service worker instead of opening a tab?
 *   Chrome MV3 service workers can fetch URLs directly with the extension's
 *   host_permissions. This avoids interrupting the user with a visible tab.
 *   Note: sites with heavy anti-bot protection may block this; in that case
 *   the passive update from content.js (when the user visits the page) is the
 *   reliable fallback.
 *
 * Phase 2 — Email notifications:
 *   Stubbed below. Implement by calling your serverless endpoint (Firebase
 *   Functions, Supabase Edge Function, Vercel, etc.) with the item and
 *   recipient email address from settings.
 */

import {
  getAllItems,
  getItem,
  getSettings,
  recordPrice,
  saveSettings,
} from '../utils/storage.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

const ALARM_NAME    = 'pricethread_check';
const ICON_PATH     = '/icons/icon48.png';

// Minimum drop percentage to trigger a notification.
// Drops smaller than this are recorded in history but silently ignored.
const MIN_DROP_PCT  = 0.05; // 5%

// ─── Installation / startup ───────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  console.log('[PriceThread] onInstalled:', reason);
  const settings = await getSettings();
  scheduleAlarm(settings.checkIntervalHours);
});

// Re-schedule alarm on browser startup (service workers can be killed between sessions)
chrome.runtime.onStartup.addListener(async () => {
  const settings = await getSettings();
  scheduleAlarm(settings.checkIntervalHours);
});

// ─── Alarm ────────────────────────────────────────────────────────────────────

function scheduleAlarm(intervalHours) {
  chrome.alarms.clear(ALARM_NAME, () => {
    chrome.alarms.create(ALARM_NAME, {
      delayInMinutes:  intervalHours * 60,   // first run after one interval
      periodInMinutes: intervalHours * 60,   // repeat
    });
    console.log(`[PriceThread] Alarm scheduled every ${intervalHours}h`);
  });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  console.log('[PriceThread] Running scheduled price check');
  await checkAllPrices();
});

// ─── Price checking ───────────────────────────────────────────────────────────

async function checkAllPrices() {
  const items    = await getAllItems();
  const settings = await getSettings();
  const active   = Object.values(items).filter(item => item.isActive);

  console.log(`[PriceThread] Checking ${active.length} active items`);

  for (const item of active) {
    try {
      await checkItemPrice(item, settings);
    } catch (err) {
      console.warn(`[PriceThread] Failed to check "${item.name}":`, err.message);
    }
  }
}

/**
 * Fetch the product page and extract the current price via JSON-LD.
 * Falls back gracefully if the fetch fails or price can't be parsed.
 */
async function checkItemPrice(item, settings) {
  const response = await fetch(item.url, {
    method: 'GET',
    headers: {
      // Mimic a regular browser request to reduce bot-detection triggers
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control':   'no-cache',
    },
    credentials: 'omit',
  });

  if (!response.ok) {
    console.warn(`[PriceThread] HTTP ${response.status} for ${item.url}`);
    return;
  }

  const html = await response.text();

  const { price, inventory } = parseFromHtml(html);

  if (!price) {
    console.warn(`[PriceThread] Could not parse price from ${item.url}`);
    return;
  }

  const result = await recordPrice(item.id, price, inventory);
  if (!result) return;

  const { dropped, prevPrice, newPrice } = result;

  // ── Notify: price drop (only if drop meets the minimum threshold) ──
  if (dropped && prevPrice !== newPrice) {
    const dropPct = (prevPrice - newPrice) / prevPrice;
    if (dropPct >= MIN_DROP_PCT) {
      console.log(`[PriceThread] Price drop on "${item.name}": ${prevPrice} → ${newPrice} (${Math.round(dropPct * 100)}%)`);
      await notifyPriceDrop(item, prevPrice, newPrice, settings);
    } else {
      console.log(`[PriceThread] Drop on "${item.name}" too small to notify (${Math.round(dropPct * 100)}% < ${MIN_DROP_PCT * 100}%)`);
    }
  }

  // ── Notify: inventory change (low / sold out) ──
  const prevInventory = item.inventory;
  if (inventory !== prevInventory &&
      (inventory === 'low' || inventory === 'out_of_stock' || inventory === 'sold')) {
    await notifyInventoryChange(item, inventory, settings);
  }
}

// ─── HTML parsing ─────────────────────────────────────────────────────────────

/**
 * Extract price + inventory from raw HTML by scanning JSON-LD blocks.
 * We don't spin up a full DOM parser in the service worker — a regex scan is
 * sufficient and avoids loading a heavy library.
 */
function parseFromHtml(html) {
  const blockRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = blockRe.exec(html)) !== null) {
    let parsed;
    try { parsed = JSON.parse(match[1]); } catch { continue; }

    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    for (const node of candidates) {
      if (node['@type'] !== 'Product') continue;

      const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
      if (!offer) continue;

      const price = parseFloat(offer.price);
      if (isNaN(price)) continue;

      const avail = (offer.availability || '').toLowerCase();
      let inventory = 'unknown';
      if      (avail.includes('outofstock'))       inventory = 'out_of_stock';
      else if (avail.includes('limitedavail'))     inventory = 'low';
      else if (avail.includes('instock'))          inventory = 'in_stock';
      else if (avail.includes('discontinued'))     inventory = 'sold';

      return { price, inventory };
    }
  }

  return { price: null, inventory: 'unknown' };
}

// ─── Notifications ────────────────────────────────────────────────────────────

function fmtPrice(price, currency = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency,
    minimumFractionDigits: 0, maximumFractionDigits: 2,
  }).format(price);
}

async function notifyPriceDrop(item, prevPrice, newPrice, settings) {
  if (!settings.browserNotifications) return;

  const drop    = prevPrice - newPrice;
  const pct     = Math.round((drop / prevPrice) * 100);
  const notifId = `drop_${item.id}_${Date.now()}`;

  chrome.notifications.create(notifId, {
    type:    'basic',
    iconUrl: ICON_PATH,
    title:   `Price drop on ${item.brand || item.name}`,
    message: `${item.siteName}: ${fmtPrice(prevPrice, item.currency)} → ${fmtPrice(newPrice, item.currency)} (${pct}% off, save ${fmtPrice(drop, item.currency)})`,
    buttons: [{ title: 'View item' }],
  });

  // ── Phase 2: Email notification ──────────────────────────────────────────────
  // if (settings.emailNotifications && settings.emailAddress && item.notifications?.email) {
  //   await sendEmailNotification({
  //     to:      settings.emailAddress,
  //     subject: `Price drop: ${item.name}`,
  //     body:    `${item.siteName} dropped from ${fmtPrice(prevPrice)} to ${fmtPrice(newPrice)}.\n${item.url}`,
  //   });
  // }
}

async function notifyInventoryChange(item, inventory, settings) {
  if (!settings.browserNotifications) return;

  const labels = {
    low:          `Low inventory — only a few left`,
    out_of_stock: `Now out of stock`,
    sold:         `This item has sold`,
  };

  const message = labels[inventory];
  if (!message) return;

  chrome.notifications.create(`inv_${item.id}_${Date.now()}`, {
    type:    'basic',
    iconUrl: ICON_PATH,
    title:   `Inventory alert: ${item.brand || item.name}`,
    message: `${item.siteName}: ${message}`,
    buttons: [{ title: 'View item' }],
  });

  // Phase 2: email stub (same pattern as above)
}

// Open the item's page when the user clicks "View item" in a notification
chrome.notifications.onButtonClicked.addListener(async (notifId, btnIdx) => {
  if (btnIdx !== 0) return;

  // Extract itemId from notification ID format: "drop_<itemId>_<ts>"
  const parts  = notifId.split('_');
  const itemId = parts[1];
  if (!itemId) return;

  const item = await getItem(itemId);
  if (item?.url) {
    chrome.tabs.create({ url: item.url });
  }

  chrome.notifications.clear(notifId);
});

// ─── Messages from popup / content scripts ────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {

    // Popup updated check interval in settings — reschedule the alarm
    case 'UPDATE_CHECK_INTERVAL':
      scheduleAlarm(message.intervalHours);
      sendResponse({ success: true });
      break;

    // Content script pushed a live price update (user just visited the page)
    case 'PAGE_PRICE_UPDATE': {
      const { data } = message;
      if (!data?.id || !data?.price) break;

      getItem(data.id).then(async (item) => {
        if (!item) return; // not tracked; do nothing
        const settings = await getSettings();
        const result   = await recordPrice(data.id, data.price, data.inventory);
        if (result?.dropped) {
          const dropPct = (result.prevPrice - result.newPrice) / result.prevPrice;
          if (dropPct >= MIN_DROP_PCT) {
            await notifyPriceDrop(item, result.prevPrice, result.newPrice, settings);
          }
        }
      });
      break;
    }

    default:
      break;
  }

  return true;
});
